import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { runCaptain } from '@/lib/agent/orchestrator'
import { buildAgentTextBlocks } from '@/lib/slack/blocks'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** Return the local hour (0-23) for a given IANA timezone string. */
function getLocalHour(timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    })
    const parts = formatter.formatToParts(new Date())
    const hourPart = parts.find((p) => p.type === 'hour')
    return hourPart ? parseInt(hourPart.value, 10) : -1
  } catch {
    return -1
  }
}

/** Return today's date string in the user's local timezone (YYYY-MM-DD). */
function getLocalDateString(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Get all onboarded profiles with timezone info
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, org_id, email, full_name, timezone')
    .not('onboarded_at', 'is', null)

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, skipped: 0 })
  }

  let processed = 0
  let skipped = 0
  const errors: string[] = []

  for (const profile of profiles) {
    try {
      // ── Timezone gate ─────────────────────────────────────────────────────
      // Only send morning brief when it's 6–9 AM in the user's local timezone.
      // This lets the cron run at multiple UTC offsets without double-sending.
      const tz = profile.timezone ?? 'UTC'
      const localHour = getLocalHour(tz)
      if (localHour < 6 || localHour >= 9) {
        skipped++
        continue
      }

      // ── Deduplication ─────────────────────────────────────────────────────
      // Skip if a morning brief was already sent today in the user's timezone.
      const todayLocal = getLocalDateString(tz)
      const { data: existing } = await admin
        .from('briefs')
        .select('id')
        .eq('user_id', profile.id)
        .eq('type', 'morning')
        .gte('sent_at', `${todayLocal}T00:00:00`)
        .lte('sent_at', `${todayLocal}T23:59:59`)
        .limit(1)
        .maybeSingle()

      if (existing) {
        skipped++
        continue
      }

      // ── Slack client ───────────────────────────────────────────────────────
      const slackClient = await getSlackClient(profile.org_id)
      if (!slackClient) {
        skipped++
        continue
      }

      // ── Generate brief via agent ───────────────────────────────────────────
      const firstName = profile.full_name?.split(' ')[0] ?? 'there'
      const now = new Date()
      const dateLabel = now.toLocaleDateString('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })

      let fullResponse = ''
      const agentStream = runCaptain({
        orgId: profile.org_id,
        userId: profile.id,
        message: `Generate ${firstName}'s morning brief for ${dateLabel}. Include: today's calendar events (with times), urgent emails needing attention, at-risk commitments or upcoming deadlines, pending actions awaiting approval, and any compliance alerts. Lead with the highest-priority item. Be crisp — no more than 300 words total.`,
        conversationId: `cron-morning-${profile.id}-${todayLocal}`,
      })

      for await (const event of agentStream) {
        if (event.type === 'text' && event.content) {
          fullResponse += event.content
        }
      }

      if (!fullResponse) {
        skipped++
        continue
      }

      // ── Store in DB ────────────────────────────────────────────────────────
      const { data: brief } = await admin
        .from('briefs')
        .insert({
          org_id: profile.org_id,
          user_id: profile.id,
          type: 'morning',
          title: `Morning Brief — ${dateLabel}`,
          content: { text: fullResponse },
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_via: 'slack',
        })
        .select('id')
        .single()

      // ── Send via Slack DM ──────────────────────────────────────────────────
      if (profile.email) {
        try {
          const userResult = await slackClient.users.lookupByEmail({ email: profile.email })
          if (userResult.user?.id) {
            const conversation = await slackClient.conversations.open({ users: userResult.user.id })
            if (conversation.channel?.id) {
              const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()
              const blocks = buildAgentTextBlocks({
                header: `☀️ Morning Brief — ${dateLabel}`,
                text: fullResponse,
                footerText: `Captain • Sent at ${now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' })} ${tz}`,
                appUrl: appUrl ? `${appUrl}/chat` : undefined,
              })

              const msgResult = await slackClient.chat.postMessage({
                channel: conversation.channel.id,
                text: `☀️ Morning Brief — ${dateLabel}`,
                blocks,
              })

              if (brief?.id && msgResult.ts) {
                await admin
                  .from('briefs')
                  .update({ slack_message_ts: msgResult.ts })
                  .eq('id', brief.id)
              }
            }
          }
        } catch (slackErr) {
          console.error(`[morning-brief] Slack DM failed for ${profile.email}:`, slackErr)
        }
      }

      processed++
    } catch (err) {
      const errorMsg = `[morning-brief] Error for user ${profile.id}: ${(err as Error).message}`
      console.error(errorMsg)
      errors.push(errorMsg)
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors })
}
