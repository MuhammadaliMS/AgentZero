import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { TokenManager } from '@/lib/integrations/token-manager'
import { logCronRun } from '@/lib/observability/cron-logger'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Cron: Meeting Sync
 *
 * Runs every 5 minutes. For each org with a connected Google Calendar:
 * 1. Fetches events for the next 24 hours that have a video call link
 * 2. Upserts into the meetings table (dedup by calendar_event_id)
 * 3. Applies bot rules to decide which meetings to join vs skip
 *
 * The VPS bot then polls the meetings table for status='scheduled' meetings
 * starting within 2 minutes.
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  waitUntil(runMeetingSyncBackground())

  return NextResponse.json({ ok: true, status: 'accepted' })
}

// ─── Types ───────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string
  title: string
  start: string | null
  end: string | null
  meetingUrl: string | null
  platform: 'google_meet' | 'zoom' | 'teams' | null
  organizer: string | null
  attendees: Array<{ name?: string; email: string; status?: string }>
  description: string | null
}

interface BotConfig {
  enabled: boolean
  join_mode: string
  min_attendees: number
  record_label: string
  excluded_calendars: string[]
  blocklist_patterns: string[]
}

// ─── Background Runner ───────────────────────────────────────────────────

async function runMeetingSyncBackground() {
  await logCronRun({ worker: 'meeting-sync' }, async () => {
    const admin = createAdminClient() as any // meeting tables not in generated types yet

    // Get all orgs with connected calendar
    const { data: orgs } = await admin
      .from('organization_integrations')
      .select('org_id, integration:integrations!inner(key)')
      .eq('is_active', true)
      .in('integrations.key', ['google_calendar', 'gmail'])

    if (!orgs || orgs.length === 0) {
      return { summary: 'No orgs with connected calendars' }
    }

    // Dedup org_ids (might have both google_calendar and gmail)
    const orgIds = [...new Set(orgs.map((o: any) => o.org_id as string))]
    let synced = 0
    let failed = 0

    for (const orgId of orgIds) {
      try {
        await syncOrgMeetings(admin, orgId as string)
        synced++
      } catch (err) {
        console.error(`[meeting-sync] Failed for org ${orgId}:`, (err as Error).message)
        failed++
      }
    }

    return {
      summary: `Synced ${synced}/${orgIds.length} orgs (${failed} failed)`,
      metrics: { orgs: orgIds.length, synced, failed },
    }
  })
}

async function syncOrgMeetings(
  admin: any, // meeting tables not in generated types yet
  orgId: string
): Promise<void> {
  // 1. Fetch bot config
  const { data: botConfig } = await admin
    .from('meeting_bot_config')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle()

  // If bot is disabled for this org, skip
  if (botConfig && !botConfig.enabled) return

  const config: BotConfig = {
    enabled: botConfig?.enabled ?? true,
    join_mode: botConfig?.join_mode ?? 'all',
    min_attendees: botConfig?.min_attendees ?? 3,
    record_label: botConfig?.record_label ?? '[record]',
    excluded_calendars: (botConfig?.excluded_calendars as string[]) ?? [],
    blocklist_patterns: (botConfig?.blocklist_patterns as string[]) ?? [],
  }

  // 2. Fetch calendar events for the next 7 days
  const now = new Date()
  const timeMin = now.toISOString()
  const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const events = await fetchCalendarEventsWithMeetingUrls(orgId, timeMin, timeMax)

  if (events.length === 0) return

  // 3. Upsert each event into meetings table, applying bot rules
  let synced = 0
  let skipped = 0

  for (const event of events) {
    if (!event.meetingUrl) continue

    // Apply bot rules
    const ruleResult = applyBotRules(event, config)

    // Upsert meeting (dedup by calendar_event_id)
    const { error } = await admin
      .from('meetings')
      .upsert(
        {
          org_id: orgId,
          calendar_event_id: event.id,
          calendar_provider: 'google_calendar',
          title: event.title,
          meeting_url: event.meetingUrl,
          platform: event.platform,
          scheduled_start: event.start,
          scheduled_end: event.end,
          organizer_email: event.organizer,
          participants: event.attendees.map(a => ({
            name: a.name || a.email.split('@')[0],
            email: a.email,
          })),
          status: ruleResult.allowed ? 'scheduled' : 'skipped',
          skip_reason: ruleResult.reason || null,
          bot_rule_applied: ruleResult as Record<string, unknown>,
        },
        {
          onConflict: 'org_id,calendar_event_id',
          // Don't overwrite status if meeting is already in progress or completed
          ignoreDuplicates: false,
        }
      )

    if (error) {
      // If conflict on a meeting that's already past 'scheduled', skip silently
      if (error.code === '23505') continue
      console.error(`[meeting-sync] Upsert failed for event ${event.id}:`, error.message)
      continue
    }

    if (ruleResult.allowed) synced++
    else skipped++
  }

  if (synced > 0 || skipped > 0) {
    console.log(`[meeting-sync] Org ${orgId.slice(0, 8)}: ${synced} synced, ${skipped} skipped`)
  }
}

// ─── Calendar Fetch (reuses same Google Calendar API as calendar-tools) ──

async function fetchCalendarEventsWithMeetingUrls(
  orgId: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarEvent[]> {
  // Try Google Calendar tokens
  let tokens = await TokenManager.getTokens(orgId, 'google_calendar')
  if (!tokens) {
    tokens = await TokenManager.getTokens(orgId, 'gmail')
  }

  if (!tokens) return []

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  })

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  )

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      console.warn(`[meeting-sync] Calendar auth expired for org ${orgId.slice(0, 8)}`)
    }
    return []
  }

  const data = await response.json()
  const events: CalendarEvent[] = []

  for (const item of data.items || []) {
    // Extract meeting URL from conferenceData or description
    const meetingInfo = extractMeetingUrl(item)

    events.push({
      id: item.id,
      title: item.summary || '(no title)',
      start: item.start?.dateTime || item.start?.date || null,
      end: item.end?.dateTime || item.end?.date || null,
      meetingUrl: meetingInfo.url,
      platform: meetingInfo.platform,
      organizer: item.organizer?.email || null,
      attendees: (item.attendees || []).map((a: Record<string, string>) => ({
        name: a.displayName,
        email: a.email,
        status: a.responseStatus,
      })),
      description: item.description?.slice(0, 500) || null,
    })
  }

  return events
}

// ─── Meeting URL Extraction ──────────────────────────────────────────────

function extractMeetingUrl(event: Record<string, unknown>): {
  url: string | null
  platform: 'google_meet' | 'zoom' | 'teams' | null
} {
  // 1. Check conferenceData (Google Meet native)
  const conferenceData = event.conferenceData as {
    entryPoints?: Array<{ entryPointType: string; uri: string }>
  } | undefined

  if (conferenceData?.entryPoints) {
    const videoEntry = conferenceData.entryPoints.find(
      ep => ep.entryPointType === 'video'
    )
    if (videoEntry?.uri) {
      return { url: videoEntry.uri, platform: 'google_meet' }
    }
  }

  // 2. Check hangoutLink (legacy Meet)
  if (typeof event.hangoutLink === 'string') {
    return { url: event.hangoutLink, platform: 'google_meet' }
  }

  // 3. Scan description and location for Zoom / Teams URLs
  const textToScan = [
    event.description as string || '',
    event.location as string || '',
  ].join(' ')

  // Zoom patterns
  const zoomMatch = textToScan.match(
    /https?:\/\/[\w.-]*zoom\.us\/(?:j|wc\/join)\/\d+[^\s<)"]*/i
  )
  if (zoomMatch) {
    return { url: zoomMatch[0], platform: 'zoom' }
  }

  // Teams patterns
  const teamsMatch = textToScan.match(
    /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<)"]+/i
  )
  if (teamsMatch) {
    return { url: teamsMatch[0], platform: 'teams' }
  }

  return { url: null, platform: null }
}

// ─── Bot Rules Engine ────────────────────────────────────────────────────

function applyBotRules(
  event: CalendarEvent,
  config: BotConfig
): { allowed: boolean; reason: string | null; rule: string } {
  // 1. Check blocklist patterns
  for (const pattern of config.blocklist_patterns) {
    if (pattern && event.title.toLowerCase().includes(pattern.toLowerCase())) {
      return { allowed: false, reason: `Blocklist: "${pattern}"`, rule: 'blocklist' }
    }
  }

  // 2. Apply join mode
  switch (config.join_mode) {
    case 'all':
      // Join everything with a meeting URL
      return { allowed: true, reason: null, rule: 'all' }

    case 'min_attendees': {
      const attendeeCount = event.attendees.length
      if (attendeeCount < config.min_attendees) {
        return {
          allowed: false,
          reason: `Only ${attendeeCount} attendees (min: ${config.min_attendees})`,
          rule: 'min_attendees',
        }
      }
      return { allowed: true, reason: null, rule: 'min_attendees' }
    }

    case 'labeled': {
      const hasLabel = event.title.includes(config.record_label)
      if (!hasLabel) {
        return {
          allowed: false,
          reason: `Missing label "${config.record_label}"`,
          rule: 'labeled',
        }
      }
      return { allowed: true, reason: null, rule: 'labeled' }
    }

    case 'manual':
      // Only manually triggered meetings (never auto-schedule)
      return { allowed: false, reason: 'Manual mode', rule: 'manual' }

    default:
      return { allowed: true, reason: null, rule: 'default' }
  }
}
