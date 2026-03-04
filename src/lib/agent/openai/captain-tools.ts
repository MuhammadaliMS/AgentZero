/**
 * OpenAI Agents SDK — Captain Tools
 *
 * All 37 Captain tools converted from Claude Agent SDK format to OpenAI Agents SDK format.
 * Each tool returns a plain string (not MCP content arrays).
 *
 * Tools are wrapped with:
 * - Integration gating: blocks if required integration isn't connected
 * - Approval gating: blocks sensitive tools until user approves in chat UI
 * - Event emission: emits tool_use/tool_result events for real-time UI updates
 */

import { tool } from '@openai/agents'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, isOpenAIConfigured } from '@/lib/openai/client'
import { WebClient } from '@slack/web-api'
import { trackActionResolvedAfterNudge } from '@/lib/intelligence/feedback-tracker'
import { persistDecisionCard, type DecisionCardTriggerType } from '@/lib/agent/reasoning/decision-card'
import { createApprovalRequest } from '../approval-store'
import {
  getRequiredIntegration,
  getRequiredIntegrations,
  formatToolDisplayName,
  buildApprovalTitle,
  buildApprovalDescription,
} from '../tool-metadata'
import type { StreamEvent } from '../orchestrator'
import type { Json } from '@/types/database'
import { executeCreateOutcome, executeUpdateOutcome, executeListOutcomes } from '../tools/outcome-tools'

// ─── Tool Context ────────────────────────────────────────────────────────────

export interface CaptainToolParams {
  orgId: string
  userId: string
  conversationId: string
  connectedIntegrations: string[]
  /** When true, approval and integration gates auto-reject instead of blocking. */
  headlessMode?: boolean
  onEmitEvent?: (event: StreamEvent) => void
  /** Callback invoked with raw tool output data (for extraction pipeline). */
  onToolOutput?: (toolName: string, output: string) => void
}

// ─── Schema Compatibility Patch ──────────────────────────────────────────────
// Safety net: ensures ALL properties in each tool's JSON Schema are in `required`.
// Primary fix is using `.nullable()` on Zod schemas (not `.optional()`), which
// produces proper `anyOf: [{type}, {type: "null"}]` schemas with all fields required.
// This patch is a defense-in-depth guard for any edge cases.

function patchToolSchemas<T extends { parameters?: Record<string, unknown> }>(tools: T[]): T[] {
  for (const t of tools) {
    const params = t.parameters as Record<string, unknown> | undefined
    if (params?.properties && typeof params.properties === 'object') {
      const allKeys = Object.keys(params.properties as object)
      const currentRequired = new Set(
        Array.isArray(params.required) ? (params.required as string[]) : []
      )
      for (const key of allKeys) {
        if (!currentRequired.has(key)) {
          if (!Array.isArray(params.required)) params.required = [...currentRequired]
          ;(params.required as string[]).push(key)
        }
      }
    }
  }
  return tools
}

/** Convert null to undefined — used to bridge Zod `.nullable()` types to APIs expecting `T | undefined`. */
const nu = <T,>(v: T | null | undefined): T | undefined => v ?? undefined

// ─── Permission Sets ─────────────────────────────────────────────────────────

const TOOLS_REQUIRING_APPROVAL = new Set([
  'send_slack_dm',
  'post_to_channel',
  'send_approval_message',
  'update_slack_message',
  'draft_email',
  'send_email',
  'create_commitment',
  'create_action',
  'resolve_action',
  'create_calendar_event',
])

const READ_ONLY_TOOLS = new Set([
  'recall_memory',
  'query_entity_graph',
  'get_entity_timeline',
  'query_commitments',
  'query_actions',
  'read_recent_emails',
  'search_emails',
  'read_email',
  'list_slack_channels',
  'read_slack_channel',
  'read_slack_thread',
  'read_slack_dms',
  'get_slack_mentions',
  'get_today_events',
  'get_week_events',
  'find_free_slots',
  'get_compliance_overview',
  'list_failing_controls',
  'get_audit_status',
  'list_connected_integrations',
  'get_integration_health',
  'list_outcomes',
  'list_entities',
  'list_narratives',
  'get_narrative',
  'search_slack',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract plain-text body from Gmail MIME payload.
 * Recursively walks multipart structures.
 */
function extractGmailBody(payload: Record<string, unknown>): string {
  const mimeType = payload.mimeType as string | undefined
  const body = payload.body as { data?: string; size?: number } | undefined

  // Direct text/plain or text/html body
  if (body?.data && (mimeType === 'text/plain' || mimeType === 'text/html')) {
    const decoded = Buffer.from(body.data, 'base64url').toString('utf-8')
    return mimeType === 'text/html' ? stripHtml(decoded) : decoded
  }

  // Multipart — recurse into parts
  const parts = payload.parts as Array<Record<string, unknown>> | undefined
  if (parts) {
    // Prefer text/plain
    for (const part of parts) {
      if ((part.mimeType as string) === 'text/plain') {
        const result = extractGmailBody(part)
        if (result) return result
      }
    }
    // Fallback to text/html
    for (const part of parts) {
      if ((part.mimeType as string) === 'text/html') {
        const result = extractGmailBody(part)
        if (result) return result
      }
    }
    // Recurse into nested multipart
    for (const part of parts) {
      const result = extractGmailBody(part)
      if (result) return result
    }
  }

  return ''
}

const GMAIL_LABEL_MAP: Record<string, string> = {
  INBOX: 'Inbox', SENT: 'Sent', DRAFT: 'Draft', SPAM: 'Spam',
  TRASH: 'Trash', UNREAD: 'Unread', STARRED: 'Starred', IMPORTANT: 'Important',
  CATEGORY_PERSONAL: 'Personal', CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
}

function mapGmailLabels(labelIds: string[]): string[] {
  return labelIds
    .map((id) => GMAIL_LABEL_MAP[id] || null)
    .filter(Boolean) as string[]
}

/** Build RFC 2822 raw email as base64url string for Gmail send API. */
function buildGmailRawMessage(args: {
  to: string
  subject: string
  body: string
  cc?: string | null
  bcc?: string | null
  reply_to?: string | null
  in_reply_to?: string | null
}): string {
  const lines: string[] = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ]
  if (args.cc) lines.push(`Cc: ${args.cc}`)
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`)
  if (args.reply_to) lines.push(`Reply-To: ${args.reply_to}`)
  if (args.in_reply_to) lines.push(`In-Reply-To: ${args.in_reply_to}`)
  lines.push('', args.body)
  const raw = lines.join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

/** Resolve Slack user IDs to display names in parallel. */
async function resolveUserNames(
  client: WebClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const userMap = new Map<string, string>()
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const info = await client.users.info({ user: uid })
        userMap.set(uid, info.user?.real_name || info.user?.name || uid)
      } catch {
        userMap.set(uid, uid)
      }
    })
  )
  return userMap
}

/** Handle Slack errors — detect auth errors. */
function handleSlackError(e: unknown): string {
  const msg = (e as Error).message || String(e)
  if (msg.includes('not_authed') || msg.includes('invalid_auth') || msg.includes('token_revoked')) {
    return 'Slack authentication failed — the integration may need to be reconnected.'
  }
  return `Slack error: ${msg}`
}

// ─── Timezone Helpers (Calendar) ─────────────────────────────────────────────

function tzDateToUTC(dateStr: string, tz: string): string {
  try {
    const d = new Date(dateStr)
    const utcStr = d.toLocaleString('en-US', { timeZone: tz })
    return new Date(utcStr).toISOString()
  } catch {
    return new Date(dateStr).toISOString()
  }
}

function formatTimeInTz(isoStr: string, tz: string): string {
  try {
    return new Date(isoStr).toLocaleString('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return isoStr
  }
}

function getTodayBounds(tz: string): { start: string; end: string } {
  const now = new Date()
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
  return {
    start: tzDateToUTC(`${todayStr}T00:00:00`, tz),
    end: tzDateToUTC(`${todayStr}T23:59:59`, tz),
  }
}

function getDaysBounds(tz: string, daysAhead: number): { start: string; end: string } {
  const now = new Date()
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
  const endDate = new Date(now)
  endDate.setDate(endDate.getDate() + daysAhead)
  const endStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(endDate)
  return {
    start: tzDateToUTC(`${todayStr}T00:00:00`, tz),
    end: tzDateToUTC(`${endStr}T23:59:59`, tz),
  }
}

async function fetchCalendarEvents(
  orgId: string,
  timeMin: string,
  timeMax: string,
  maxResults = 30
): Promise<string> {
  // Try Google Calendar first
  const googleTokens = await TokenManager.getTokens(orgId, 'google_calendar')
  if (googleTokens) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=${maxResults}`,
        { headers: { Authorization: `Bearer ${googleTokens.access_token}` } }
      )
      const data = (await res.json()) as { items?: Array<Record<string, unknown>>; error?: { message: string } }
      if (data.error) return `Google Calendar error: ${data.error.message}`

      const events = (data.items ?? []).map((e) => ({
        summary: e.summary,
        start: (e.start as Record<string, unknown>)?.dateTime || (e.start as Record<string, unknown>)?.date,
        end: (e.end as Record<string, unknown>)?.dateTime || (e.end as Record<string, unknown>)?.date,
        location: e.location,
        description: typeof e.description === 'string' ? e.description.substring(0, 200) : undefined,
        attendees: Array.isArray(e.attendees)
          ? (e.attendees as Array<{ email: string }>).map((a) => a.email).slice(0, 10)
          : [],
        hangoutLink: e.hangoutLink,
      }))
      return JSON.stringify(events, null, 2)
    } catch (e) {
      return `Google Calendar error: ${(e as Error).message}`
    }
  }

  // Try Microsoft Calendar
  const msTokens = await TokenManager.getTokens(orgId, 'microsoft_calendar')
  if (msTokens) {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$orderby=start/dateTime&$top=${maxResults}&$select=subject,start,end,location,bodyPreview,attendees`,
        {
          headers: {
            Authorization: `Bearer ${msTokens.access_token}`,
            Prefer: 'outlook.timezone="UTC"',
          },
        }
      )
      const data = (await res.json()) as { value?: Array<Record<string, unknown>>; error?: { message: string } }
      if (data.error) return `Microsoft Calendar error: ${data.error.message}`
      return JSON.stringify(data.value ?? [], null, 2)
    } catch (e) {
      return `Microsoft Calendar error: ${(e as Error).message}`
    }
  }

  return 'No calendar integration connected.'
}

async function createCalendarEventImpl(
  orgId: string,
  args: {
    title: string
    start_time: string
    end_time: string
    attendees: string[] | null
    location: string | null
    description: string | null
    timezone: string | null
  }
): Promise<string> {
  const tz = args.timezone ?? 'UTC'

  // Try Google Calendar first
  const googleTokens = await TokenManager.getTokens(orgId, 'google_calendar')
  if (googleTokens) {
    try {
      const body: Record<string, unknown> = {
        summary: args.title,
        start: { dateTime: args.start_time, timeZone: tz },
        end: { dateTime: args.end_time, timeZone: tz },
      }
      if (args.attendees && args.attendees.length > 0) {
        body.attendees = args.attendees.map((email) => ({ email }))
      }
      if (args.location) body.location = args.location
      if (args.description) body.description = args.description

      const res = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${googleTokens.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      )
      const data = (await res.json()) as {
        id?: string
        htmlLink?: string
        summary?: string
        start?: { dateTime?: string }
        end?: { dateTime?: string }
        attendees?: Array<{ email: string }>
        error?: { message: string }
      }
      if (data.error) return `Google Calendar error: ${data.error.message}`
      return JSON.stringify({
        eventId: data.id,
        title: data.summary,
        start: data.start?.dateTime,
        end: data.end?.dateTime,
        attendees: (data.attendees ?? []).map((a) => a.email),
        link: data.htmlLink,
        provider: 'google',
      }, null, 2)
    } catch (e) {
      return `Google Calendar error: ${(e as Error).message}`
    }
  }

  // Try Microsoft Calendar
  const msTokens = await TokenManager.getTokens(orgId, 'microsoft_calendar')
  if (msTokens) {
    try {
      const body: Record<string, unknown> = {
        subject: args.title,
        start: { dateTime: args.start_time, timeZone: tz },
        end: { dateTime: args.end_time, timeZone: tz },
      }
      if (args.attendees && args.attendees.length > 0) {
        body.attendees = args.attendees.map((email) => ({
          emailAddress: { address: email },
          type: 'required',
        }))
      }
      if (args.location) body.location = { displayName: args.location }
      if (args.description) body.body = { contentType: 'text', content: args.description }

      const res = await fetch(
        'https://graph.microsoft.com/v1.0/me/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${msTokens.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      )
      const data = (await res.json()) as {
        id?: string
        webLink?: string
        subject?: string
        start?: { dateTime?: string }
        end?: { dateTime?: string }
        attendees?: Array<{ emailAddress?: { address?: string } }>
        error?: { message: string; code?: string }
      }
      if (data.error) {
        if (data.error.code === 'ErrorAccessDenied' || data.error.code === 'AuthorizationRequestDenied') {
          return 'Microsoft Calendar error: Insufficient permissions. Please reconnect Microsoft Calendar to grant write access (Calendars.ReadWrite scope).'
        }
        return `Microsoft Calendar error: ${data.error.message}`
      }
      return JSON.stringify({
        eventId: data.id,
        title: data.subject,
        start: data.start?.dateTime,
        end: data.end?.dateTime,
        attendees: (data.attendees ?? []).map((a) => a.emailAddress?.address).filter(Boolean),
        link: data.webLink,
        provider: 'microsoft',
      }, null, 2)
    } catch (e) {
      return `Microsoft Calendar error: ${(e as Error).message}`
    }
  }

  return 'No calendar integration connected.'
}

function computeFreeSlots(
  events: Array<{ start: string; end: string }>,
  tz: string,
  daysAhead: number,
  workStartHour = 9,
  workEndHour = 17
): Array<{ date: string; start: string; end: string; durationMinutes: number }> {
  const slots: Array<{ date: string; start: string; end: string; durationMinutes: number }> = []
  const now = new Date()

  for (let d = 0; d < daysAhead; d++) {
    const date = new Date(now)
    date.setDate(date.getDate() + d)
    const dayOfWeek = date.getDay()
    if (dayOfWeek === 0 || dayOfWeek === 6) continue // Skip weekends

    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date)

    const dayEvents = events
      .filter((e) => {
        const eventDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(e.start))
        return eventDate === dateStr
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    let cursor = new Date(`${dateStr}T${String(workStartHour).padStart(2, '0')}:00:00`)
    const endOfDay = new Date(`${dateStr}T${String(workEndHour).padStart(2, '0')}:00:00`)

    for (const event of dayEvents) {
      const eventStart = new Date(event.start)
      if (eventStart > cursor) {
        const durationMinutes = Math.round((eventStart.getTime() - cursor.getTime()) / 60000)
        if (durationMinutes >= 15) {
          slots.push({
            date: dateStr,
            start: formatTimeInTz(cursor.toISOString(), tz),
            end: formatTimeInTz(eventStart.toISOString(), tz),
            durationMinutes,
          })
        }
      }
      const eventEnd = new Date(event.end)
      if (eventEnd > cursor) cursor = eventEnd
    }

    if (cursor < endOfDay) {
      const durationMinutes = Math.round((endOfDay.getTime() - cursor.getTime()) / 60000)
      if (durationMinutes >= 15) {
        slots.push({
          date: dateStr,
          start: formatTimeInTz(cursor.toISOString(), tz),
          end: formatTimeInTz(endOfDay.toISOString(), tz),
          durationMinutes,
        })
      }
    }
  }

  return slots
}

// Vanta control summarizer
function summarizeControls(controls: Array<{
  name?: string
  monitorStatus?: string
  controlFrameworks?: Array<{ name?: string }>
  severity?: string
}>): Record<string, unknown> {
  const total = controls.length
  const byStatus: Record<string, number> = {}
  const failing: Array<{ name: string; status: string; severity: string }> = []
  const frameworks = new Set<string>()

  for (const c of controls) {
    const status = c.monitorStatus ?? 'UNKNOWN'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    if (['FAILING', 'AT_RISK', 'DISABLED', 'NEEDS_ATTENTION'].includes(status)) {
      failing.push({
        name: c.name ?? 'Unknown',
        status,
        severity: c.severity ?? 'unknown',
      })
    }
    for (const fw of c.controlFrameworks ?? []) {
      if (fw.name) frameworks.add(fw.name)
    }
  }

  const passing = byStatus['IN_PLACE'] ?? 0
  const healthScore = total > 0 ? Math.round((passing / total) * 100) : 0

  return {
    health_score: healthScore,
    total_controls: total,
    status_breakdown: byStatus,
    failing_controls: failing.slice(0, 10),
    frameworks: Array.from(frameworks),
  }
}

// ─── Wrapped Execute Pattern ─────────────────────────────────────────────────
// Wraps tool execution with integration gating + approval gating + event emission.

async function wrappedExecute(
  toolName: string,
  toolInput: Record<string, unknown>,
  params: CaptainToolParams,
  executeFn: () => Promise<string>
): Promise<string> {
  const { orgId, conversationId, connectedIntegrations, onEmitEvent } = params

  // 1. Emit tool_use event
  onEmitEvent?.({
    type: 'tool_use',
    toolName,
    toolInput,
    toolDisplayName: formatToolDisplayName(toolName),
  })

  const startTime = Date.now()

  // 2. Integration gate: check if tool requires a connected integration
  // Multi-provider: email tools accept gmail OR outlook, calendar accepts google OR microsoft.
  const requiredIntegrationsList = getRequiredIntegrations(toolName)
  const requiredIntegration = requiredIntegrationsList[0] ?? null // Primary for connect prompt
  const hasAnyProvider = requiredIntegrationsList.some(i => connectedIntegrations.includes(i.key))
  if (requiredIntegration && !hasAnyProvider) {
    // Headless mode: auto-skip instead of blocking for user interaction
    if (params.headlessMode) {
      const result = `[SKIPPED] Tool "${toolName}" requires ${requiredIntegration.name} integration which is not connected. Cannot prompt user in headless mode.`
      onEmitEvent?.({
        type: 'tool_result',
        toolName,
        content: 'skipped (headless — integration not connected)',
        durationMs: Date.now() - startTime,
      })
      return result
    }

    const displayName = formatToolDisplayName(toolName)

    // Create a blocking approval request (reuses pending_approvals table)
    const { approvalId, promise } = await createApprovalRequest(
      'INTEGRATION_CONNECT',
      {
        integration_key: requiredIntegration.key,
        integration_name: requiredIntegration.name,
        triggering_tool: toolName,
      },
      conversationId,
      orgId
    )

    // Emit integration_required to SSE
    onEmitEvent?.({
      type: 'integration_required',
      approvalId,
      integrationKey: requiredIntegration.key,
      integrationName: requiredIntegration.name,
      toolName,
      toolDisplayName: displayName,
      content: `To ${displayName.toLowerCase()}, I need access to ${requiredIntegration.name}.`,
    })

    // Block until user connects (or timeout auto-dismisses after 2 min)
    const decision = await promise

    onEmitEvent?.({
      type: 'integration_resolved',
      approvalId,
      integrationKey: requiredIntegration.key,
      decision: decision === 'approve' ? 'connected' : 'dismissed',
    })

    if (decision === 'approve') {
      // Update in-memory list so subsequent calls don't re-prompt
      connectedIntegrations.push(requiredIntegration.key)
    } else {
      const result = `The user chose not to connect ${requiredIntegration.name}. Do not retry — acknowledge and move on.`
      onEmitEvent?.({
        type: 'tool_result',
        toolName,
        content: 'skipped (integration not connected)',
        durationMs: Date.now() - startTime,
      })
      return result
    }
  }

  // 3. Approval gate: sensitive tools require explicit user approval
  if (TOOLS_REQUIRING_APPROVAL.has(toolName)) {
    // Headless mode: auto-skip instead of blocking for user approval
    if (params.headlessMode) {
      const result = `[SKIPPED] Tool "${toolName}" requires user approval. Cannot execute in headless mode.`
      onEmitEvent?.({
        type: 'tool_result',
        toolName,
        content: 'skipped (headless — approval required)',
        durationMs: Date.now() - startTime,
      })
      return result
    }

    const { approvalId, promise } = await createApprovalRequest(
      toolName,
      toolInput,
      conversationId,
      orgId
    )

    onEmitEvent?.({
      type: 'approval_required',
      approvalId,
      toolName,
      toolInput,
      toolDisplayName: formatToolDisplayName(toolName),
      approvalTitle: buildApprovalTitle(toolName, toolInput),
      approvalDescription: buildApprovalDescription(toolName, toolInput),
    })

    const decision = await promise

    onEmitEvent?.({
      type: 'approval_resolved',
      approvalId,
      toolName,
      approvalDecision: decision === 'approve' ? 'approved' : 'rejected',
    })

    if (decision !== 'approve') {
      const result = 'The user chose not to proceed with this action.'
      onEmitEvent?.({
        type: 'tool_result',
        toolName,
        content: 'rejected by user',
        durationMs: Date.now() - startTime,
      })
      return result
    }
  }

  // 4. Execute the actual tool logic
  try {
    const result = await executeFn()

    // Capture rich tool output for entity extraction (capped at 4000 chars)
    if (params.onToolOutput && result && result.length > 20) {
      try { params.onToolOutput(toolName, result.slice(0, 4000)) } catch {}
    }

    // ── Outcome stream events ──
    // Emit semantic events when outcome tools complete
    try {
      if (toolName === 'create_outcome' && result) {
        const parsed = JSON.parse(result)
        if (parsed.outcomeId && parsed.status === 'executing') {
          onEmitEvent?.({
            type: 'outcome_started',
            outcomeId: parsed.outcomeId,
            outcomeTitle: parsed.planSummary ?? 'New outcome',
            outcomeStatus: 'executing',
          })
        }
      } else if (toolName === 'update_outcome' && result) {
        const parsed = JSON.parse(result)
        if (parsed.statusChanged && parsed.newStatus) {
          const eventType =
            parsed.newStatus === 'blocked' ? 'outcome_blocked' as const
            : ['completed', 'failed', 'cancelled'].includes(parsed.newStatus)
              ? 'outcome_completed' as const
              : null
          if (eventType) {
            onEmitEvent?.({
              type: eventType,
              outcomeId: parsed.outcomeId,
              outcomeStatus: parsed.newStatus,
              content: parsed.blockerSummary ?? undefined,
            })
          }
        }
      }
    } catch {
      // Parsing failures are non-fatal
    }

    onEmitEvent?.({
      type: 'tool_result',
      toolName,
      content: 'success',
      durationMs: Date.now() - startTime,
    })
    return result
  } catch (e) {
    const errorMsg = `Error: ${(e as Error).message}`
    onEmitEvent?.({
      type: 'tool_result',
      toolName,
      content: `failed: ${(e as Error).message}`,
      durationMs: Date.now() - startTime,
    })
    return errorMsg
  }
}

// ─── Tool Factory ────────────────────────────────────────────────────────────

export function createCaptainTools(params: CaptainToolParams) {
  const { orgId } = params
  const supabase = createAdminClient()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // EMAIL TOOLS (5)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const readRecentEmails = tool({
    name: 'read_recent_emails',
    description: 'Fetch recent emails with subjects, senders, dates, and snippets. Supports Gmail and Outlook.',
    parameters: z.object({
      max_results: z.number().nullable().default(15),
      query: z.string().nullable().default(null).describe('Gmail search query (e.g., "is:unread", "newer_than:1d")'),
      label: z.enum(['inbox', 'sent', 'drafts', 'starred', 'important', 'unread']).nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('read_recent_emails', args as Record<string, unknown>, params, async () => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        let q = args.query || 'newer_than:1d'
        if (args.label) {
          const labelMap: Record<string, string> = { inbox: 'in:inbox', sent: 'in:sent', drafts: 'in:drafts', starred: 'is:starred', important: 'is:important', unread: 'is:unread' }
          q = `${labelMap[args.label] || ''} ${q}`.trim()
        }
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.max_results}&q=${encodeURIComponent(q)}`,
          { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
        )
        const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
        if (listData.error) return `Gmail API error: ${listData.error.message}`
        if (!listData.messages?.length) return 'No emails found matching query.'

        const emails = await Promise.all(
          listData.messages.slice(0, args.max_results ?? 15).map(async (msg) => {
            const detailRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`,
              { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
            )
            const detail = (await detailRes.json()) as {
              id: string; snippet: string; labelIds?: string[]
              payload?: { headers?: Array<{ name: string; value: string }> }
            }
            const headers = detail.payload?.headers ?? []
            const getH = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
            return {
              id: detail.id,
              subject: getH('Subject'),
              from: getH('From'),
              to: getH('To'),
              date: getH('Date'),
              snippet: detail.snippet,
              labels: detail.labelIds ? mapGmailLabels(detail.labelIds) : [],
            }
          })
        )
        return JSON.stringify(emails, null, 2)
      }

      // Outlook fallback
      const outlookTokens = await TokenManager.getTokens(orgId, 'outlook')
      if (outlookTokens) {
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages?$top=${args.max_results}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,toRecipients`,
          { headers: { Authorization: `Bearer ${outlookTokens.access_token}` } }
        )
        const data = (await res.json()) as { value?: Array<Record<string, unknown>>; error?: { message: string } }
        if (data.error) return `Outlook API error: ${data.error.message}`
        return JSON.stringify(data.value ?? [], null, 2)
      }

      return 'No email integration connected.'
    }),
  })

  const searchEmails = tool({
    name: 'search_emails',
    description: 'Search emails with a specific query. Supports Gmail and Outlook.',
    parameters: z.object({
      query: z.string().describe('Search query (e.g., "action required", "from:ceo@company.com")'),
      max_results: z.number().nullable().default(10),
    }),
    execute: async (args) => wrappedExecute('search_emails', args as Record<string, unknown>, params, async () => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.max_results}&q=${encodeURIComponent(args.query)}`,
          { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
        )
        const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
        if (listData.error) return `Gmail search error: ${listData.error.message}`
        if (!listData.messages?.length) return `No emails found for query: "${args.query}"`

        const emails = await Promise.all(
          listData.messages.slice(0, args.max_results ?? 15).map(async (msg) => {
            const detailRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
            )
            const detail = (await detailRes.json()) as {
              id: string; snippet: string
              payload?: { headers?: Array<{ name: string; value: string }> }
            }
            const headers = detail.payload?.headers ?? []
            const getH = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
            return { id: detail.id, subject: getH('Subject'), from: getH('From'), date: getH('Date'), snippet: detail.snippet }
          })
        )
        return JSON.stringify(emails, null, 2)
      }

      const outlookTokens = await TokenManager.getTokens(orgId, 'outlook')
      if (outlookTokens) {
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(args.query)}"&$top=${args.max_results}&$select=id,subject,from,receivedDateTime,bodyPreview`,
          { headers: { Authorization: `Bearer ${outlookTokens.access_token}` } }
        )
        const data = (await res.json()) as { value?: Array<Record<string, unknown>>; error?: { message: string } }
        if (data.error) return `Outlook search error: ${data.error.message}`
        return JSON.stringify(data.value ?? [], null, 2)
      }

      return 'No email integration connected.'
    }),
  })

  const readEmail = tool({
    name: 'read_email',
    description: 'Read the full body of a specific email by ID.',
    parameters: z.object({
      email_id: z.string().describe('The email message ID'),
    }),
    execute: async (args) => wrappedExecute('read_email', args as Record<string, unknown>, params, async () => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.email_id}?format=full`,
          { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
        )
        const data = (await res.json()) as Record<string, unknown>
        if ((data as { error?: { message: string } }).error) return `Gmail error: ${(data as { error: { message: string } }).error.message}`

        const headers = ((data.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) ?? []
        const getH = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
        const body = extractGmailBody(data.payload as Record<string, unknown>)

        return JSON.stringify({
          id: data.id,
          subject: getH('Subject'),
          from: getH('From'),
          to: getH('To'),
          cc: getH('Cc'),
          date: getH('Date'),
          body: body.substring(0, 5000),
        }, null, 2)
      }

      const outlookTokens = await TokenManager.getTokens(orgId, 'outlook')
      if (outlookTokens) {
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${args.email_id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body`,
          { headers: { Authorization: `Bearer ${outlookTokens.access_token}` } }
        )
        const data = (await res.json()) as Record<string, unknown>
        if ((data as { error?: { message: string } }).error) return `Outlook error: ${(data as { error: { message: string } }).error.message}`
        const body = data.body as { content?: string; contentType?: string } | undefined
        if (body?.contentType === 'html' && body.content) {
          (data as Record<string, unknown>).body = { content: stripHtml(body.content).substring(0, 5000), contentType: 'text' }
        }
        return JSON.stringify(data, null, 2)
      }

      return 'No email integration connected.'
    }),
  })

  const draftEmail = tool({
    name: 'draft_email',
    description: 'Draft an email (saved as draft, not sent). Requires user approval.',
    parameters: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().nullable().default(null),
      bcc: z.string().nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('draft_email', args as Record<string, unknown>, params, async () => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        const raw = buildGmailRawMessage(args)
        const res = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${gmailTokens.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { raw } }),
          }
        )
        const data = (await res.json()) as { id?: string; error?: { message: string } }
        if (data.error) return `Gmail draft error: ${data.error.message}`
        return `Email draft created (ID: ${data.id}). Subject: "${args.subject}" To: ${args.to}`
      }

      const outlookTokens = await TokenManager.getTokens(orgId, 'outlook')
      if (outlookTokens) {
        const res = await fetch(
          'https://graph.microsoft.com/v1.0/me/messages',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${outlookTokens.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subject: args.subject,
              body: { contentType: 'text', content: args.body },
              toRecipients: args.to.split(',').map((e) => ({ emailAddress: { address: e.trim() } })),
              ...(args.cc ? { ccRecipients: args.cc.split(',').map((e) => ({ emailAddress: { address: e.trim() } })) } : {}),
            }),
          }
        )
        const data = (await res.json()) as { id?: string; error?: { message: string } }
        if (data.error) return `Outlook draft error: ${data.error.message}`
        return `Email draft created (ID: ${data.id}). Subject: "${args.subject}" To: ${args.to}`
      }

      return 'No email integration connected.'
    }),
  })

  const sendEmail = tool({
    name: 'send_email',
    description: 'Send an email immediately. Requires user approval. Use draft_email for less urgent messages.',
    parameters: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().nullable().default(null),
      bcc: z.string().nullable().default(null),
      reply_to: z.string().nullable().default(null),
      in_reply_to: z.string().nullable().default(null).describe('Message-ID header for threading replies'),
    }),
    execute: async (args) => wrappedExecute('send_email', args as Record<string, unknown>, params, async () => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        const raw = buildGmailRawMessage(args)
        const res = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${gmailTokens.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }),
          }
        )
        const data = (await res.json()) as { id?: string; error?: { message: string } }
        if (data.error) return `Gmail send error: ${data.error.message}`
        return `Email sent successfully (ID: ${data.id}). Subject: "${args.subject}" To: ${args.to}`
      }

      const outlookTokens = await TokenManager.getTokens(orgId, 'outlook')
      if (outlookTokens) {
        const res = await fetch(
          'https://graph.microsoft.com/v1.0/me/sendMail',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${outlookTokens.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                subject: args.subject,
                body: { contentType: 'text', content: args.body },
                toRecipients: args.to.split(',').map((e) => ({ emailAddress: { address: e.trim() } })),
                ...(args.cc ? { ccRecipients: args.cc.split(',').map((e) => ({ emailAddress: { address: e.trim() } })) } : {}),
              },
            }),
          }
        )
        if (!res.ok) {
          const data = (await res.json()) as { error?: { message: string } }
          return `Outlook send error: ${data.error?.message ?? res.statusText}`
        }
        return `Email sent successfully via Outlook. Subject: "${args.subject}" To: ${args.to}`
      }

      return 'No email integration connected.'
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SLACK TOOLS (9)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function getSlackBotClient(): Promise<WebClient | null> {
    const tokens = await TokenManager.getTokens(orgId, 'slack')
    if (!tokens) return null
    return new WebClient(tokens.access_token)
  }

  async function getSlackUserClient(): Promise<WebClient | null> {
    const tokens = await TokenManager.getTokens(orgId, 'slack')
    if (!tokens) return null
    return new WebClient(tokens.user_access_token || tokens.access_token)
  }

  const sendSlackDm = tool({
    name: 'send_slack_dm',
    description: 'Send a direct message to a user via Slack. Requires user approval.',
    parameters: z.object({
      user_email: z.string().describe('Email address of the Slack user to DM'),
      message: z.string().describe('Message text (supports Slack mrkdwn)'),
    }),
    execute: async (args) => wrappedExecute('send_slack_dm', args as Record<string, unknown>, params, async () => {
      const client = await getSlackBotClient()
      if (!client) return 'Slack not connected.'
      try {
        const userResult = await client.users.lookupByEmail({ email: args.user_email })
        if (!userResult.user?.id) return `Could not find Slack user with email: ${args.user_email}`
        const conv = await client.conversations.open({ users: userResult.user.id })
        if (!conv.channel?.id) return 'Could not open DM channel.'
        const result = await client.chat.postMessage({ channel: conv.channel.id, text: args.message })
        return JSON.stringify({ status: 'sent', channel: conv.channel.id, ts: result.ts, user: userResult.user.real_name || userResult.user.name })
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const postToChannel = tool({
    name: 'post_to_channel',
    description: 'Post a message to a Slack channel. Requires user approval.',
    parameters: z.object({
      channel_id: z.string(),
      message: z.string(),
      thread_ts: z.string().nullable().default(null).describe('Reply in a specific thread'),
    }),
    execute: async (args) => wrappedExecute('post_to_channel', args as Record<string, unknown>, params, async () => {
      const client = await getSlackBotClient()
      if (!client) return 'Slack not connected.'
      try {
        const result = await client.chat.postMessage({
          channel: args.channel_id,
          text: args.message,
          ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        })
        return JSON.stringify({ status: 'posted', channel: args.channel_id, ts: result.ts })
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const sendApprovalMessage = tool({
    name: 'send_approval_message',
    description: 'Post an approval request message with Approve/Reject buttons in Slack. Requires user approval.',
    parameters: z.object({
      channel_id: z.string(),
      title: z.string(),
      description: z.string().nullable().default(null),
      action_id: z.string().nullable().default(null).describe('Action ID to link approval to'),
    }),
    execute: async (args) => wrappedExecute('send_approval_message', args as Record<string, unknown>, params, async () => {
      const client = await getSlackBotClient()
      if (!client) return 'Slack not connected.'
      try {
        const blocks = [
          { type: 'header', text: { type: 'plain_text', text: args.title } },
          ...(args.description ? [{ type: 'section', text: { type: 'mrkdwn', text: args.description } }] : []),
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_action', value: args.action_id || 'generic' },
            { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'reject_action', value: args.action_id || 'generic' },
            { type: 'button', text: { type: 'plain_text', text: 'Defer' }, action_id: 'defer_action', value: args.action_id || 'generic' },
          ]},
        ]
        const result = await client.chat.postMessage({ channel: args.channel_id, text: args.title, blocks })
        return JSON.stringify({ status: 'posted', channel: args.channel_id, ts: result.ts })
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const updateSlackMessage = tool({
    name: 'update_slack_message',
    description: 'Update an existing Slack message. Requires user approval.',
    parameters: z.object({
      channel: z.string(),
      ts: z.string().describe('Message timestamp to update'),
      text: z.string(),
    }),
    execute: async (args) => wrappedExecute('update_slack_message', args as Record<string, unknown>, params, async () => {
      const client = await getSlackBotClient()
      if (!client) return 'Slack not connected.'
      try {
        await client.chat.update({ channel: args.channel, ts: args.ts, text: args.text })
        return `Message updated in ${args.channel} at ${args.ts}.`
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const listSlackChannels = tool({
    name: 'list_slack_channels',
    description: 'List available Slack channels with topics and member counts.',
    parameters: z.object({
      limit: z.number().nullable().default(50),
    }),
    execute: async (args) => wrappedExecute('list_slack_channels', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const res = await client.conversations.list({ types: 'public_channel,private_channel', limit: args.limit ?? 50, exclude_archived: true })
        const channels = (res.channels ?? []).map((c) => ({
          id: c.id, name: c.name,
          topic: c.topic?.value?.substring(0, 100),
          purpose: c.purpose?.value?.substring(0, 100),
          num_members: c.num_members,
        }))
        return JSON.stringify(channels, null, 2)
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const readSlackChannel = tool({
    name: 'read_slack_channel',
    description: 'Read recent messages from a Slack channel.',
    parameters: z.object({
      channel_id: z.string(),
      limit: z.number().nullable().default(20),
    }),
    execute: async (args) => wrappedExecute('read_slack_channel', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const res = await client.conversations.history({ channel: args.channel_id, limit: args.limit ?? 20 })
        if (!res.messages?.length) return 'No messages found in channel.'
        const userIds = [...new Set(res.messages.map((m) => m.user).filter(Boolean) as string[])]
        const userMap = await resolveUserNames(client, userIds)
        const messages = res.messages.map((m) => ({
          from: userMap.get(m.user ?? '') ?? m.user ?? 'unknown',
          text: m.text?.substring(0, 400),
          ts: m.ts, thread_ts: m.thread_ts,
          reply_count: (m as Record<string, unknown>).reply_count ?? 0,
        }))
        return JSON.stringify(messages, null, 2)
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const readSlackThread = tool({
    name: 'read_slack_thread',
    description: 'Read all replies in a specific Slack thread.',
    parameters: z.object({
      channel_id: z.string(),
      thread_ts: z.string().describe('Thread parent message timestamp'),
      limit: z.number().nullable().default(30),
    }),
    execute: async (args) => wrappedExecute('read_slack_thread', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const res = await client.conversations.replies({ channel: args.channel_id, ts: args.thread_ts, limit: args.limit ?? 30 })
        if (!res.messages?.length) return 'No thread replies found.'
        const userIds = [...new Set(res.messages.map((m) => m.user).filter(Boolean) as string[])]
        const userMap = await resolveUserNames(client, userIds)
        const messages = res.messages.map((m) => ({
          from: userMap.get(m.user ?? '') ?? m.user ?? 'unknown',
          text: m.text?.substring(0, 400),
          ts: m.ts,
        }))
        return JSON.stringify(messages, null, 2)
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const readSlackDms = tool({
    name: 'read_slack_dms',
    description: 'Read recent direct messages (DMs) from Slack.',
    parameters: z.object({
      limit: z.number().nullable().default(20),
    }),
    execute: async (args) => wrappedExecute('read_slack_dms', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const convRes = await client.conversations.list({ types: 'im', limit: 10 })
        const dms: Array<Record<string, unknown>> = []
        for (const conv of (convRes.channels ?? []).slice(0, 5)) {
          if (!conv.id) continue
          const histRes = await client.conversations.history({ channel: conv.id, limit: Math.min(args.limit ?? 20, 5) })
          for (const msg of histRes.messages ?? []) {
            dms.push({ channel: conv.id, user: conv.user, text: msg.text?.substring(0, 300), ts: msg.ts })
          }
        }
        if (dms.length === 0) return 'No recent DMs found.'
        // Resolve user names
        const userIds = [...new Set(dms.map((d) => d.user as string).filter(Boolean))]
        const userMap = await resolveUserNames(client, userIds)
        for (const dm of dms) {
          dm.from = userMap.get(dm.user as string) ?? dm.user
        }
        return JSON.stringify(dms, null, 2)
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const getSlackMentions = tool({
    name: 'get_slack_mentions',
    description: 'Get recent @mentions and messages directed at you in Slack.',
    parameters: z.object({
      hours_back: z.number().nullable().default(24),
    }),
    execute: async (args) => wrappedExecute('get_slack_mentions', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const results: Array<Record<string, unknown>> = []
        const searchRes = await client.search.messages({
          query: `to:me after:${Math.floor((Date.now() - (args.hours_back ?? 24) * 3600_000) / 1000)}`,
          count: 20, sort: 'timestamp', sort_dir: 'desc',
        })
        if (searchRes.messages?.matches) {
          for (const match of searchRes.messages.matches.slice(0, 15)) {
            results.push({
              channel: match.channel?.name ?? 'unknown',
              from: match.username ?? 'unknown',
              text: match.text?.substring(0, 300),
              ts: match.ts, permalink: match.permalink,
            })
          }
        }
        return results.length > 0 ? JSON.stringify(results, null, 2) : 'No recent mentions or DMs found.'
      } catch (e) { return handleSlackError(e) }
    }),
  })

  const searchSlack = tool({
    name: 'search_slack',
    description: 'Search Slack messages across ALL channels (including external/Slack Connect channels). Use this to find messages from a specific person, about a topic, or in a specific channel. Uses the user token so it sees everything the user sees. Supports Slack search modifiers: from:@user, in:#channel, has:link, before:YYYY-MM-DD, after:YYYY-MM-DD, etc.',
    parameters: z.object({
      query: z.string().describe('Slack search query. Examples: "from:@komal budget", "in:#axari-development deploy", "security incident after:2026-03-01"'),
      count: z.number().nullable().default(20).describe('Number of results to return (max 50)'),
      sort: z.enum(['timestamp', 'score']).nullable().default('timestamp').describe('Sort by timestamp (newest first) or relevance score'),
    }),
    execute: async (args) => wrappedExecute('search_slack', args as Record<string, unknown>, params, async () => {
      const client = await getSlackUserClient()
      if (!client) return 'Slack not connected.'
      try {
        const searchRes = await client.search.messages({
          query: args.query,
          count: Math.min(args.count ?? 20, 50),
          sort: args.sort ?? 'timestamp',
          sort_dir: 'desc',
        })
        if (!searchRes.messages?.matches || searchRes.messages.matches.length === 0) {
          return `No Slack messages found for query: "${args.query}"`
        }
        const results = searchRes.messages.matches.slice(0, Math.min(args.count ?? 20, 50)).map((match) => ({
          channel: match.channel?.name ?? 'unknown',
          channel_id: match.channel?.id ?? 'unknown',
          from: match.username ?? 'unknown',
          text: match.text?.substring(0, 500),
          ts: match.ts,
          permalink: match.permalink,
        }))
        return JSON.stringify(results, null, 2)
      } catch (e) { return handleSlackError(e) }
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CALENDAR TOOLS (3)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const getTodayEvents = tool({
    name: 'get_today_events',
    description: "Get today's calendar events with times, attendees, and locations.",
    parameters: z.object({
      timezone: z.string().nullable().default('UTC'),
    }),
    execute: async (args) => wrappedExecute('get_today_events', args as Record<string, unknown>, params, async () => {
      const bounds = getTodayBounds(args.timezone ?? 'UTC')
      return fetchCalendarEvents(orgId, bounds.start, bounds.end)
    }),
  })

  const getWeekEvents = tool({
    name: 'get_week_events',
    description: 'Get calendar events for the next N days.',
    parameters: z.object({
      days_ahead: z.number().nullable().default(7),
      timezone: z.string().nullable().default('UTC'),
    }),
    execute: async (args) => wrappedExecute('get_week_events', args as Record<string, unknown>, params, async () => {
      const bounds = getDaysBounds(args.timezone ?? 'UTC', args.days_ahead ?? 7)
      return fetchCalendarEvents(orgId, bounds.start, bounds.end, 50)
    }),
  })

  const findFreeSlots = tool({
    name: 'find_free_slots',
    description: 'Find available time slots in the calendar for scheduling.',
    parameters: z.object({
      days_ahead: z.number().nullable().default(5),
      timezone: z.string().nullable().default('UTC'),
      work_start_hour: z.number().nullable().default(9),
      work_end_hour: z.number().nullable().default(17),
    }),
    execute: async (args) => wrappedExecute('find_free_slots', args as Record<string, unknown>, params, async () => {
      const tz = args.timezone ?? 'UTC'
      const days = args.days_ahead ?? 5
      const bounds = getDaysBounds(tz, days)
      const eventsStr = await fetchCalendarEvents(orgId, bounds.start, bounds.end, 100)
      try {
        const events = JSON.parse(eventsStr) as Array<{ start: string; end: string }>
        if (!Array.isArray(events)) return eventsStr // Error message
        const slots = computeFreeSlots(events, tz, days, args.work_start_hour ?? 9, args.work_end_hour ?? 17)
        return JSON.stringify(slots, null, 2)
      } catch {
        return eventsStr // Propagate the error message
      }
    }),
  })

  const createCalendarEvent = tool({
    name: 'create_calendar_event',
    description: 'Create a calendar event/meeting invite with title, time, attendees, and optional location/description. Sends invites to attendees automatically.',
    parameters: z.object({
      title: z.string().describe('Event title/summary'),
      start_time: z.string().describe('ISO 8601 start time (e.g. 2024-03-15T10:00:00-05:00)'),
      end_time: z.string().describe('ISO 8601 end time'),
      attendees: z.array(z.string()).nullable().default(null).describe('Email addresses of attendees to invite'),
      location: z.string().nullable().default(null).describe('Physical or virtual location'),
      description: z.string().nullable().default(null).describe('Event description or agenda'),
      timezone: z.string().nullable().default(null).describe('IANA timezone (e.g. America/New_York). Defaults to UTC.'),
    }),
    execute: async (args) => wrappedExecute('create_calendar_event', args as Record<string, unknown>, params, async () => {
      return createCalendarEventImpl(orgId, {
        title: args.title,
        start_time: args.start_time,
        end_time: args.end_time,
        attendees: args.attendees,
        location: args.location,
        description: args.description,
        timezone: args.timezone,
      })
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // COMPLIANCE / VANTA TOOLS (3)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const getComplianceOverview = tool({
    name: 'get_compliance_overview',
    description: 'Get compliance posture from Vanta — health score, failing controls, and frameworks.',
    parameters: z.object({}),
    execute: async (args) => wrappedExecute('get_compliance_overview', args as Record<string, unknown>, params, async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) return 'Vanta not connected.'
      try {
        const res = await fetch('https://api.vanta.com/v1/resources/controls', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
        })
        const data = (await res.json()) as { results?: { data?: Array<Record<string, unknown>> }; error?: string }
        if (data.error) return `Vanta API error: ${data.error}`
        const controls = (data.results?.data ?? []) as Array<{ name?: string; monitorStatus?: string; controlFrameworks?: Array<{ name?: string }>; severity?: string }>
        return JSON.stringify(summarizeControls(controls), null, 2)
      } catch (e) { return `Vanta error: ${(e as Error).message}` }
    }),
  })

  const listFailingControls = tool({
    name: 'list_failing_controls',
    description: 'List all failing or at-risk Vanta controls with details.',
    parameters: z.object({}),
    execute: async (args) => wrappedExecute('list_failing_controls', args as Record<string, unknown>, params, async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) return 'Vanta not connected.'
      try {
        const res = await fetch('https://api.vanta.com/v1/resources/controls', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
        })
        const data = (await res.json()) as { results?: { data?: Array<Record<string, unknown>> }; error?: string }
        if (data.error) return `Vanta API error: ${data.error}`

        const controls = (data.results?.data ?? []) as Array<{ name?: string; monitorStatus?: string; description?: string; severity?: string; controlFrameworks?: Array<{ name?: string }> }>
        const failing = controls.filter((c) =>
          ['FAILING', 'AT_RISK', 'DISABLED', 'NEEDS_ATTENTION'].includes(c.monitorStatus ?? '')
        ).map((c) => ({
          name: c.name, status: c.monitorStatus, severity: c.severity,
          description: typeof c.description === 'string' ? c.description.substring(0, 200) : undefined,
          frameworks: (c.controlFrameworks ?? []).map((f) => f.name).filter(Boolean),
        }))
        return failing.length > 0 ? JSON.stringify(failing, null, 2) : 'No failing controls found.'
      } catch (e) { return `Vanta error: ${(e as Error).message}` }
    }),
  })

  const getAuditStatus = tool({
    name: 'get_audit_status',
    description: 'Get current audit readiness status from Vanta.',
    parameters: z.object({}),
    execute: async (args) => wrappedExecute('get_audit_status', args as Record<string, unknown>, params, async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) return 'Vanta not connected.'
      try {
        const res = await fetch('https://api.vanta.com/v1/resources/controls', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
        })
        const data = (await res.json()) as { results?: { data?: Array<Record<string, unknown>> }; error?: string }
        if (data.error) return `Vanta API error: ${data.error}`
        const controls = (data.results?.data ?? []) as Array<{ name?: string; monitorStatus?: string; controlFrameworks?: Array<{ name?: string }>; severity?: string }>
        const summary = summarizeControls(controls)

        // Enrich with audit readiness assessment
        const healthScore = summary.health_score as number
        let readiness = 'Not Ready'
        if (healthScore >= 95) readiness = 'Audit Ready'
        else if (healthScore >= 85) readiness = 'Nearly Ready'
        else if (healthScore >= 70) readiness = 'In Progress'

        return JSON.stringify({ ...summary, audit_readiness: readiness }, null, 2)
      } catch (e) { return `Vanta error: ${(e as Error).message}` }
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MEMORY & KNOWLEDGE GRAPH TOOLS (5)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const recallMemory = tool({
    name: 'recall_memory',
    description: 'Search institutional memory. Uses text search + semantic vector similarity. Always recall before storing to check for duplicates.',
    parameters: z.object({
      query: z.string(),
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact', 'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline']).nullable().default(null),
      limit: z.number().nullable().default(10),
    }),
    execute: async (args) => wrappedExecute('recall_memory', args as Record<string, unknown>, params, async () => {
      const nowMs = Date.now()

      // Full-text search (filter out expired memories)
      let query = supabase
        .from('memory')
        .select('id, subject, content, category, confidence, related_entities, created_at, updated_at')
        .eq('org_id', orgId)
        .textSearch('subject', args.query, { type: 'websearch' })
        .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
        .order('confidence', { ascending: false })
        .limit(args.limit ?? 10)
      if (args.category) query = query.eq('category', args.category)
      const { data: textData } = await query

      // Vector search
      let vectorData: Array<Record<string, unknown>> | null = null
      if (isOpenAIConfigured()) {
        try {
          const embedding = await generateEmbedding(args.query)
          if (embedding) {
            const { data: vd } = await supabase.rpc('search_memories_by_embedding', {
              p_org_id: orgId, p_embedding: JSON.stringify(embedding), p_limit: args.limit ?? 10, p_category: args.category ?? null,
            })
            vectorData = vd as Array<Record<string, unknown>> | null
          }
        } catch { /* Vector search is optional */ }
      }

      // Merge
      const seenIds = new Set<string>()
      const merged: Array<Record<string, unknown>> = []
      for (const mem of textData ?? []) { seenIds.add(mem.id); merged.push({ ...mem, _source: 'text' }) }
      if (vectorData) {
        for (const vm of vectorData) {
          const memId = vm.memory_id as string
          if (!seenIds.has(memId)) { seenIds.add(memId); merged.push({ ...vm, _source: 'vector' }) }
        }
      }

      // Fallback ilike (also filter expired)
      if (merged.length === 0) {
        const { data: fallback } = await supabase
          .from('memory')
          .select('id, subject, content, category, confidence, related_entities, created_at, updated_at')
          .eq('org_id', orgId)
          .or(`subject.ilike.%${args.query}%,content.ilike.%${args.query}%`)
          .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
          .limit(args.limit ?? 10)
        if (fallback) for (const mem of fallback) merged.push({ ...mem, _source: 'ilike' })
      }

      // Graph context (entity links)
      try {
        const { data: entities } = await supabase
          .from('entities')
          .select('id, name')
          .eq('org_id', orgId)
          .ilike('canonical_name', `%${args.query.toLowerCase()}%`)
          .limit(3)
        if (entities?.length) {
          const entityIds = entities.map((e) => e.id)
          const { data: links } = await supabase
            .from('memory_entity_links')
            .select('memory_id, entity_id')
            .in('entity_id', entityIds)
            .limit(10)
          if (links?.length) {
            const linkedMemoryIds = links.map((l) => l.memory_id).filter((id) => !seenIds.has(id))
            if (linkedMemoryIds.length > 0) {
              const { data: linkedMems } = await supabase
                .from('memory')
                .select('id, subject, content, category, confidence, related_entities, created_at, updated_at')
                .in('id', linkedMemoryIds)
                .limit(5)
              if (linkedMems) for (const mem of linkedMems) { seenIds.add(mem.id); merged.push({ ...mem, _source: 'graph' }) }
            }
          }
        }
      } catch { /* Graph enrichment is optional */ }

      // Apply recency weighting: boost recently updated memories
      // Recency factor: memories updated in the last 7 days get full weight,
      // older memories decay exponentially with a 30-day half-life
      const HALF_LIFE_MS = 30 * 24 * 3600_000 // 30 days
      for (const mem of merged) {
        const updatedAt = mem.updated_at || mem.created_at
        const ageMs = nowMs - new Date(updatedAt as string).getTime()
        const recencyScore = Math.pow(0.5, ageMs / HALF_LIFE_MS)
        mem._recency = Math.round(recencyScore * 100) / 100
      }

      // Sort by recency-weighted confidence (recency * confidence)
      merged.sort((a, b) => {
        const scoreA = (a._recency as number ?? 0.5) * (a.confidence as number ?? 0.5)
        const scoreB = (b._recency as number ?? 0.5) * (b.confidence as number ?? 0.5)
        return scoreB - scoreA
      })

      return merged.length > 0 ? JSON.stringify(merged, null, 2) : 'No memories found matching query.'
    }),
  })

  const storeMemory = tool({
    name: 'store_memory',
    description: 'Store or update institutional memory. Deduplicates on subject. Be aggressive about storing — duplicates auto-merge.',
    parameters: z.object({
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact', 'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline']),
      subject: z.string().describe('Short label (e.g., "SOC2 audit deadline", "Sarah Chen role")'),
      content: z.string(),
      source: z.string().nullable().default(null),
      related_entities: z.array(z.string()).nullable().default(null),
      event_date: z.string().nullable().default(null).describe('ISO date of the real-world event this memory relates to (e.g., meeting date, decision date). Use when the memory is tied to a specific date.'),
    }),
    execute: async (args) => wrappedExecute('store_memory', args as Record<string, unknown>, params, async () => {
      // Dedup check
      const { data: existing } = await supabase
        .from('memory').select('id, content, related_entities')
        .eq('org_id', orgId).ilike('subject', args.subject.trim()).limit(1).maybeSingle()

      if (existing) {
        const mergedEntities = [...new Set([...(existing.related_entities || []), ...(args.related_entities || [])])]
        const updateData: Record<string, unknown> = {
          content: args.content, category: args.category,
          related_entities: mergedEntities, source: args.source,
          updated_at: new Date().toISOString(),
        }
        if (args.event_date) updateData.event_date = args.event_date
        const { error } = await supabase.from('memory').update(updateData).eq('id', existing.id).eq('org_id', orgId)
        if (error) return `Error updating memory: ${error.message}`

        // Background embedding
        if (isOpenAIConfigured()) {
          generateEmbedding(`${args.subject}: ${args.content}`).then(async (emb) => {
            if (emb) await supabase.from('memory_embeddings').upsert({ memory_id: existing.id, embedding: JSON.stringify(emb) }, { onConflict: 'memory_id' })
          }).catch(() => {})
        }
        return `Memory updated (merged): ${args.subject} (${existing.id})`
      }

      // New insert
      const insertData: Record<string, unknown> = {
        org_id: orgId, category: args.category, subject: args.subject,
        content: args.content, source: args.source, confidence: 0.85,
        related_entities: args.related_entities,
      }
      if (args.event_date) insertData.event_date = args.event_date
      const { data, error } = await supabase.from('memory').insert(insertData as never).select('id').single()
      if (error) return `Error storing memory: ${error.message}`
      const memId = (data as { id: string }).id

      // Background embedding
      if (isOpenAIConfigured()) {
        generateEmbedding(`${args.subject}: ${args.content}`).then(async (emb) => {
          if (emb) await supabase.from('memory_embeddings').insert({ memory_id: memId, embedding: JSON.stringify(emb) })
        }).catch(() => {})
      }
      return `Memory stored: ${args.subject} (${memId})`
    }),
  })

  const updateMemory = tool({
    name: 'update_memory',
    description: 'Update specific fields on an existing memory entry.',
    parameters: z.object({
      id: z.string(),
      content: z.string().nullable().default(null),
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact', 'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline']).nullable().default(null),
      confidence: z.number().nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('update_memory', args as Record<string, unknown>, params, async () => {
      const { id, ...updates } = args
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (updates.content) updateData.content = updates.content
      if (updates.category) updateData.category = updates.category
      if (updates.confidence !== undefined) updateData.confidence = updates.confidence

      const { error } = await supabase.from('memory').update(updateData).eq('id', id).eq('org_id', orgId)
      if (error) return `Error updating memory: ${error.message}`
      return `Memory ${id} updated.`
    }),
  })

  const deleteMemory = tool({
    name: 'delete_memory',
    description: 'Delete a memory entry that is outdated, incorrect, or no longer relevant. Use after recalling memories to clean up stale information. Also deletes associated embeddings.',
    parameters: z.object({
      id: z.string().describe('Memory ID to delete'),
      reason: z.string().nullable().default(null).describe('Brief reason for deletion (for audit trail)'),
    }),
    execute: async (args) => wrappedExecute('delete_memory', args as Record<string, unknown>, params, async () => {
      // Verify memory exists and belongs to this org
      const { data: existing } = await supabase
        .from('memory')
        .select('id, subject')
        .eq('id', args.id)
        .eq('org_id', orgId)
        .maybeSingle()
      if (!existing) return `Memory ${args.id} not found or does not belong to this organization.`

      // Delete embedding first (foreign key)
      await supabase.from('memory_embeddings').delete().eq('memory_id', args.id)
      // Delete entity links
      await supabase.from('memory_entity_links').delete().eq('memory_id', args.id)
      // Delete the memory
      const { error } = await supabase.from('memory').delete().eq('id', args.id).eq('org_id', orgId)
      if (error) return `Error deleting memory: ${error.message}`

      console.log(`[Memory] Deleted memory "${existing.subject}" (${args.id}). Reason: ${args.reason ?? 'not specified'}`)
      return `Memory deleted: "${existing.subject}" (${args.id})`
    }),
  })

  const queryEntityGraph = tool({
    name: 'query_entity_graph',
    description: 'Explore connections between people, projects, controls, and decisions in the knowledge graph.',
    parameters: z.object({
      entity_name: z.string().describe('Name of the entity to explore'),
      depth: z.number().nullable().default(1),
    }),
    execute: async (args) => wrappedExecute('query_entity_graph', args as Record<string, unknown>, params, async () => {
      // Find the entity
      const { data: entity } = await supabase
        .from('entities')
        .select('id, name, entity_type, mention_count, first_seen_at, last_seen_at')
        .eq('org_id', orgId)
        .ilike('canonical_name', `%${args.entity_name.toLowerCase()}%`)
        .limit(1)
        .maybeSingle()
      if (!entity) return `No entity found matching "${args.entity_name}".`

      // Get neighborhood via RPC
      const { data: neighborhood } = await supabase.rpc('get_entity_neighborhood', {
        p_entity_id: entity.id, p_org_id: orgId, p_max_hops: args.depth ?? 2, p_active_only: true,
      })

      // Get linked memories
      const { data: links } = await supabase
        .from('memory_entity_links')
        .select('memory_id').eq('entity_id', entity.id).limit(5)
      let linkedMemories: Array<Record<string, unknown>> = []
      if (links?.length) {
        const { data: mems } = await supabase
          .from('memory').select('id, subject, content, category')
          .in('id', links.map((l) => l.memory_id)).limit(5)
        linkedMemories = mems ?? []
      }

      return JSON.stringify({ entity, neighborhood: neighborhood ?? [], linked_memories: linkedMemories }, null, 2)
    }),
  })

  const getEntityTimeline = tool({
    name: 'get_entity_timeline',
    description: 'Get the chronological timeline of events for a specific entity.',
    parameters: z.object({
      entity_name: z.string(),
      limit: z.number().nullable().default(20),
    }),
    execute: async (args) => wrappedExecute('get_entity_timeline', args as Record<string, unknown>, params, async () => {
      const { data: entity } = await supabase
        .from('entities')
        .select('id, name, entity_type')
        .eq('org_id', orgId)
        .ilike('canonical_name', `%${args.entity_name.toLowerCase()}%`)
        .limit(1)
        .maybeSingle()
      if (!entity) return `No entity found matching "${args.entity_name}".`

      const { data: timeline } = await supabase.rpc('get_entity_timeline', {
        p_entity_id: entity.id, p_org_id: orgId, p_since: null,
      })
      return JSON.stringify({ entity, timeline: timeline ?? [] }, null, 2)
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ENTITY SEARCH (1)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const listEntities = tool({
    name: 'list_entities',
    description: 'List and search entities in the knowledge graph. Returns people, projects, controls, decisions, teams, tools, vendors, and other entities. Use to discover what the organization knows about.',
    parameters: z.object({
      search: z.string().nullable().default(null).describe('Optional search term to filter entities by name'),
      entity_type: z.enum(['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process']).nullable().default(null).describe('Filter by entity type'),
      limit: z.number().nullable().default(20),
    }),
    execute: async (args) => wrappedExecute('list_entities', args as Record<string, unknown>, params, async () => {
      let q = supabase
        .from('entities')
        .select('id, name, entity_type, mention_count, first_seen_at, last_seen_at')
        .eq('org_id', orgId)
        .order('mention_count', { ascending: false })
        .limit(Math.min(args.limit ?? 20, 50))

      if (args.entity_type) q = q.eq('entity_type', args.entity_type)
      if (args.search) q = q.or(`name.ilike.%${args.search}%,canonical_name.ilike.%${args.search.toLowerCase()}%`)

      const { data, error } = await q
      if (error) return `Error listing entities: ${error.message}`
      if (!data || data.length === 0) return 'No entities found matching the criteria.'

      return JSON.stringify((data as Array<Record<string, unknown>>).map(e => ({
        id: e.id,
        name: e.name,
        type: e.entity_type,
        mentions: e.mention_count,
        first_seen: e.first_seen_at,
        last_seen: e.last_seen_at,
      })), null, 2)
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // STRATEGIC NARRATIVES (3)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const listNarratives = tool({
    name: 'list_narratives',
    description: 'List active strategic narratives — ongoing initiatives, political context, decision threads, risk threads, and relationship dynamics. These are high-level organizational context the agent tracks over time.',
    parameters: z.object({
      narrative_type: z.enum(['initiative', 'political_context', 'decision_thread', 'risk_thread', 'relationship_dynamic']).nullable().default(null).describe('Filter by narrative type'),
      limit: z.number().nullable().default(10),
    }),
    execute: async (args) => wrappedExecute('list_narratives', args as Record<string, unknown>, params, async () => {
      const { getActiveNarratives } = await import('@/lib/graph/strategic-memory')
      const narratives = await getActiveNarratives(orgId, {
        narrativeType: args.narrative_type ?? undefined,
        limit: args.limit ?? 10,
      })
      if (narratives.length === 0) return 'No active strategic narratives found.'
      return JSON.stringify(narratives.map(n => ({
        id: n.id,
        title: n.title,
        type: n.narrativeType,
        status: n.status,
        summary: n.summary,
        keyFacts: n.keyFacts.length,
        openQuestions: n.openQuestions.length,
        promotionScore: n.promotionScore,
        updatedAt: n.updatedAt,
      })), null, 2)
    }),
  })

  const getNarrative = tool({
    name: 'get_narrative',
    description: 'Get full details of a specific strategic narrative including key facts, decision history, prior outcomes, and open questions.',
    parameters: z.object({
      narrative_id: z.string().describe('ID of the narrative to retrieve'),
    }),
    execute: async (args) => wrappedExecute('get_narrative', args as Record<string, unknown>, params, async () => {
      const { data, error } = await supabase
        .from('strategic_narratives')
        .select('*')
        .eq('id', args.narrative_id)
        .eq('org_id', orgId)
        .maybeSingle()

      if (error) return `Error fetching narrative: ${error.message}`
      if (!data) return `Narrative ${args.narrative_id} not found.`

      return JSON.stringify({
        id: data.id,
        title: data.title,
        type: data.narrative_type,
        status: data.status,
        summary: data.summary,
        keyFacts: data.key_facts,
        decisionHistory: data.decision_history,
        priorOutcomes: data.prior_outcomes,
        openQuestions: data.open_questions,
        relatedEntityIds: data.related_entity_ids,
        promotionScore: data.promotion_score,
        updatedAt: data.updated_at,
        createdAt: data.created_at,
      }, null, 2)
    }),
  })

  const upsertNarrativeTool = tool({
    name: 'upsert_narrative',
    description: 'Create or update a strategic narrative. Narratives capture ongoing organizational context that persists across conversations — initiatives, political dynamics, decision threads, risk threads, and relationship dynamics. Auto-deduplicates on title + type.',
    parameters: z.object({
      title: z.string().describe('Descriptive title (e.g., "SOC2 Audit Push", "CTO Succession Planning")'),
      narrative_type: z.enum(['initiative', 'political_context', 'decision_thread', 'risk_thread', 'relationship_dynamic']),
      summary: z.string().describe('Current state summary of this narrative thread'),
      key_facts: z.array(z.object({
        fact: z.string(),
        source: z.string().nullable().default(null),
        confidence: z.number().nullable().default(null),
      })).nullable().default(null),
      decision_history: z.array(z.object({
        decision: z.string(),
        date: z.string().nullable().default(null),
        outcome: z.string().nullable().default(null),
        lesson: z.string().nullable().default(null),
      })).nullable().default(null),
      open_questions: z.array(z.object({
        question: z.string(),
        context: z.string().nullable().default(null),
        priority: z.enum(['high', 'medium', 'low']).nullable().default(null),
      })).nullable().default(null),
      related_entity_ids: z.array(z.string()).nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('upsert_narrative', args as Record<string, unknown>, params, async () => {
      const { upsertNarrative } = await import('@/lib/graph/strategic-memory')
      const narrativeId = await upsertNarrative({
        orgId,
        title: args.title,
        narrativeType: args.narrative_type,
        summary: args.summary,
        keyFacts: (args.key_facts ?? []).map(f => ({
          fact: f.fact,
          source: f.source ?? undefined,
          confidence: f.confidence ?? undefined,
        })),
        decisionHistory: (args.decision_history ?? []).map(d => ({
          decision: d.decision,
          date: d.date ?? undefined,
          outcome: d.outcome ?? undefined,
          lesson: d.lesson ?? undefined,
        })),
        openQuestions: (args.open_questions ?? []).map(q => ({
          question: q.question,
          context: q.context ?? undefined,
          priority: (q.priority as 'high' | 'medium' | 'low' | undefined) ?? undefined,
        })),
        relatedEntityIds: args.related_entity_ids ?? [],
        lastUpdatedBy: 'agent',
      })

      if (!narrativeId) return 'Failed to create/update narrative.'
      return `Narrative saved: "${args.title}" (${narrativeId})`
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // REASONING SUBSTRATE (1)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const emitDecisionCard = tool({
    name: 'emit_decision_card',
    description: 'Record a structured decision card capturing your reasoning for a significant decision. Use when choosing between approaches, making strategic recommendations, handling contradictions, escalating risks, formulating plans, or recovering from failures. Do NOT use for trivial decisions.',
    parameters: z.object({
      trigger_type: z.enum([
        'user_turn', 'proactive_signal', 'contradiction',
        'planning', 'escalation', 'recovery',
      ]),
      objective: z.string(),
      context_summary: z.string().nullable().default(null),
      options_considered: z.array(z.object({
        option: z.string(),
        pros: z.array(z.string()).nullable().default(null),
        cons: z.array(z.string()).nullable().default(null),
        rejected_reason: z.string().nullable().default(null),
      })).nullable().default(null),
      chosen_action: z.string(),
      confidence: z.number(),
      why_now: z.string().nullable().default(null),
      risk_notes: z.string().nullable().default(null),
      related_entities: z.array(z.string()).nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('emit_decision_card', args as Record<string, unknown>, params, async () => {
      const cardId = await persistDecisionCard({
        orgId,
        conversationId: params.conversationId,
        triggerType: args.trigger_type as DecisionCardTriggerType,
        triggerSource: 'chat',
        objective: args.objective,
        contextSummary: nu(args.context_summary),
        optionsConsidered: (args.options_considered ?? []).map(o => ({
          option: o.option,
          pros: o.pros ?? undefined,
          cons: o.cons ?? undefined,
          rejected_reason: o.rejected_reason ?? undefined,
        })),
        chosenAction: args.chosen_action,
        confidence: Math.max(0, Math.min(1, args.confidence)),
        whyNow: nu(args.why_now),
        riskNotes: nu(args.risk_notes),
      })

      // Emit stream event for real-time UI
      params.onEmitEvent?.({
        type: 'decision_card_emitted',
        content: `Decision: ${args.objective}`,
        decisionCardId: cardId ?? undefined,
        decisionCard: {
          objective: args.objective,
          chosenAction: args.chosen_action,
          confidence: args.confidence,
          triggerType: args.trigger_type,
          whyNow: nu(args.why_now),
          riskNotes: nu(args.risk_notes),
          optionsCount: args.options_considered?.length ?? 0,
        },
      })

      return cardId
        ? `Decision card recorded (${cardId}). Objective: ${args.objective}. Action: ${args.chosen_action}. Confidence: ${args.confidence}.`
        : 'Decision card recorded (persistence pending).'
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUPABASE / CRUD TOOLS (6)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const queryCommitments = tool({
    name: 'query_commitments',
    description: 'Query commitments for the organization. Filter by status, priority, or due date.',
    parameters: z.object({
      status: z.enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled']).nullable().default(null),
      priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
      limit: z.number().nullable().default(20),
    }),
    execute: async (args) => wrappedExecute('query_commitments', args as Record<string, unknown>, params, async () => {
      let query = supabase
        .from('commitments').select('*, profiles!owner_id(full_name)')
        .eq('org_id', orgId).order('created_at', { ascending: false }).limit(args.limit ?? 20)
      if (args.status) query = query.eq('status', args.status)
      if (args.priority) query = query.eq('priority', args.priority)
      const { data, error } = await query
      if (error) return `Error: ${error.message}`
      return JSON.stringify(data, null, 2)
    }),
  })

  const createCommitment = tool({
    name: 'create_commitment',
    description: 'Create a new commitment to track. Requires user approval.',
    parameters: z.object({
      title: z.string(),
      description: z.string().nullable().default(null),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      due_date: z.string().nullable().default(null),
      source: z.string().nullable().default(null),
      tags: z.array(z.string()).nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('create_commitment', args as Record<string, unknown>, params, async () => {
      const { data, error } = await supabase.from('commitments').insert({
        org_id: orgId, conversation_id: params.conversationId ?? null,
        title: args.title, description: args.description, priority: args.priority,
        due_date: args.due_date, source: args.source, tags: args.tags,
      }).select().single()
      if (error) return `Error: ${error.message}`
      return `Commitment created: ${(data as { title: string; id: string }).title} (${(data as { id: string }).id})`
    }),
  })

  const updateCommitment = tool({
    name: 'update_commitment',
    description: 'Update an existing commitment status, priority, or description.',
    parameters: z.object({
      id: z.string(),
      status: z.enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled']).nullable().default(null),
      priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
      due_date: z.string().nullable().default(null),
      description: z.string().nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('update_commitment', args as Record<string, unknown>, params, async () => {
      const { id, ...updates } = args
      const updateData: Record<string, unknown> = {}
      if (updates.status) updateData.status = updates.status
      if (updates.priority) updateData.priority = updates.priority
      if (updates.due_date) updateData.due_date = updates.due_date
      if (updates.description) updateData.description = updates.description
      if (updates.status === 'completed') updateData.completed_at = new Date().toISOString()
      const { error } = await supabase.from('commitments').update(updateData).eq('id', id).eq('org_id', orgId)
      if (error) return `Error: ${error.message}`
      return `Commitment ${id} updated.`
    }),
  })

  const queryActions = tool({
    name: 'query_actions',
    description: 'Query pending actions that need user approval or attention.',
    parameters: z.object({
      status: z.enum(['pending', 'approved', 'rejected', 'deferred', 'expired']).nullable().default('pending'),
      limit: z.number().nullable().default(10),
    }),
    execute: async (args) => wrappedExecute('query_actions', args as Record<string, unknown>, params, async () => {
      const { data, error } = await supabase.from('actions').select('*')
        .eq('org_id', orgId).eq('status', args.status ?? 'pending')
        .order('created_at', { ascending: false }).limit(args.limit ?? 10)
      if (error) return `Error: ${error.message}`
      return JSON.stringify(data, null, 2)
    }),
  })

  const createAction = tool({
    name: 'create_action',
    description: 'Create a pending action that needs user approval. Requires user approval.',
    parameters: z.object({
      user_id: z.string(),
      type: z.string(),
      title: z.string(),
      description: z.string().nullable().default(null),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      payload: z.string().nullable().default(null).describe('JSON string of additional data for this action'),
    }),
    execute: async (args) => wrappedExecute('create_action', args as Record<string, unknown>, params, async () => {
      let parsedPayload: Json = null
      if (args.payload) {
        try { parsedPayload = JSON.parse(args.payload) as Json } catch { parsedPayload = args.payload as Json }
      }
      const { data, error } = await supabase.from('actions').insert({
        org_id: orgId, conversation_id: params.conversationId ?? null,
        user_id: args.user_id, type: args.type, title: args.title,
        description: args.description, priority: args.priority,
        payload: parsedPayload,
      }).select().single()
      if (error) return `Error: ${error.message}`
      return `Action created: ${(data as { title: string; id: string }).title} (${(data as { id: string }).id})`
    }),
  })

  const resolveAction = tool({
    name: 'resolve_action',
    description: 'Resolve a pending action by approving, rejecting, or deferring it. Requires user approval.',
    parameters: z.object({
      id: z.string(),
      status: z.enum(['approved', 'rejected', 'deferred']),
      resolved_by: z.string().nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('resolve_action', args as Record<string, unknown>, params, async () => {
      const { error } = await supabase.from('actions').update({
        status: args.status, resolved_at: new Date().toISOString(),
        resolved_by: args.resolved_by,
      }).eq('id', args.id).eq('org_id', orgId)
      if (error) return `Error: ${error.message}`

      // Track feedback signal
      if (args.status === 'approved' || args.status === 'rejected') {
        try {
          const userId = args.resolved_by ?? ''
          if (userId) await trackActionResolvedAfterNudge(supabase, orgId, userId, args.id)
        } catch { /* Non-critical */ }
      }
      return `Action ${args.id} ${args.status}.`
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTEGRATION TOOLS (2)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const listConnectedIntegrations = tool({
    name: 'list_connected_integrations',
    description: 'List all connected integrations and their status.',
    parameters: z.object({}),
    execute: async (args) => wrappedExecute('list_connected_integrations', args as Record<string, unknown>, params, async () => {
      const { data, error } = await supabase
        .from('organization_integrations')
        .select('id, is_active, connected_at, last_sync_at, integrations!inner(key, name, category)')
        .eq('org_id', orgId)
      if (error) return `Error: ${error.message}`
      return JSON.stringify(data, null, 2)
    }),
  })

  const getIntegrationHealth = tool({
    name: 'get_integration_health',
    description: 'Check health status of connected integrations.',
    parameters: z.object({}),
    execute: async (args) => wrappedExecute('get_integration_health', args as Record<string, unknown>, params, async () => {
      const { data, error } = await supabase
        .from('organization_integrations')
        .select('is_active, last_sync_at, error_count, integrations!inner(key, name)')
        .eq('org_id', orgId)
        .eq('is_active', true)
      if (error) return `Error: ${error.message}`
      return JSON.stringify(data, null, 2)
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OUTCOME TOOLS (3)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const createOutcomeTool = tool({
    name: 'create_outcome',
    description: 'Create a multi-step tracked task (outcome). Use when a user request requires 2+ tool calls that depend on each other. Provide a title and optionally steps.',
    parameters: z.object({
      title: z.string(),
      description: z.string().nullable().default(null),
      priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
      steps: z.array(z.object({
        description: z.string(),
        action_type: z.enum(['tool_call', 'llm_reasoning', 'wait_input', 'wait_approval']),
        tool_name: z.string().nullable().default(null),
        tool_args: z.record(z.string(), z.unknown()).nullable().default(null),
        depends_on_step_orders: z.array(z.number()),
        expected_output: z.string().nullable().default(null),
        one_clear_ask: z.string().nullable().default(null),
      })).nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('create_outcome', args as Record<string, unknown>, params, async () => {
      return executeCreateOutcome(orgId, params.conversationId, args as Record<string, unknown>)
    }),
  })

  const updateOutcomeTool = tool({
    name: 'update_outcome',
    description: 'Update an outcome or its steps. Use to mark steps as completed/failed, update outcome status, or trigger a replan.',
    parameters: z.object({
      outcome_id: z.string(),
      status: z.enum(['executing', 'blocked', 'completed', 'failed', 'cancelled']).nullable().default(null),
      blocker_summary: z.string().nullable().default(null),
      step_updates: z.array(z.object({
        step_id: z.string(),
        status: z.enum(['executing', 'completed', 'failed', 'blocked', 'skipped']),
        result_summary: z.string().nullable().default(null),
        error_message: z.string().nullable().default(null),
      })).nullable().default(null),
      replan: z.boolean().nullable().default(null),
      replan_reason: z.string().nullable().default(null),
    }),
    execute: async (args) => wrappedExecute('update_outcome', args as Record<string, unknown>, params, async () => {
      return executeUpdateOutcome(orgId, args as Record<string, unknown>)
    }),
  })

  const listOutcomesTool = tool({
    name: 'list_outcomes',
    description: 'List active and recent outcomes for the organization. Shows status, blockers, and step progress.',
    parameters: z.object({
      status_filter: z.enum(['planning', 'executing', 'blocked', 'completed', 'failed', 'cancelled']).nullable().default(null),
      limit: z.number().nullable().default(10),
    }),
    execute: async (args) => wrappedExecute('list_outcomes', args as Record<string, unknown>, params, async () => {
      return executeListOutcomes(orgId, args as Record<string, unknown>)
    }),
  })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Named tool map — allows subagents to pick subsets by tool name
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const toolMap: Record<string, ReturnType<typeof tool>> = {
    // Email (5)
    read_recent_emails: readRecentEmails,
    search_emails: searchEmails,
    read_email: readEmail,
    draft_email: draftEmail,
    send_email: sendEmail,
    // Slack (9)
    send_slack_dm: sendSlackDm,
    post_to_channel: postToChannel,
    send_approval_message: sendApprovalMessage,
    update_slack_message: updateSlackMessage,
    list_slack_channels: listSlackChannels,
    read_slack_channel: readSlackChannel,
    read_slack_thread: readSlackThread,
    read_slack_dms: readSlackDms,
    get_slack_mentions: getSlackMentions,
    search_slack: searchSlack,
    // Calendar (4)
    get_today_events: getTodayEvents,
    get_week_events: getWeekEvents,
    find_free_slots: findFreeSlots,
    create_calendar_event: createCalendarEvent,
    // Compliance (3)
    get_compliance_overview: getComplianceOverview,
    list_failing_controls: listFailingControls,
    get_audit_status: getAuditStatus,
    // Memory & Knowledge Graph (10)
    recall_memory: recallMemory,
    store_memory: storeMemory,
    update_memory: updateMemory,
    delete_memory: deleteMemory,
    query_entity_graph: queryEntityGraph,
    get_entity_timeline: getEntityTimeline,
    list_entities: listEntities,
    // Strategic Narratives (3)
    list_narratives: listNarratives,
    get_narrative: getNarrative,
    upsert_narrative: upsertNarrativeTool,
    // Reasoning (1)
    emit_decision_card: emitDecisionCard,
    // Supabase CRUD (6)
    query_commitments: queryCommitments,
    create_commitment: createCommitment,
    update_commitment: updateCommitment,
    query_actions: queryActions,
    create_action: createAction,
    resolve_action: resolveAction,
    // Integration (2)
    list_connected_integrations: listConnectedIntegrations,
    get_integration_health: getIntegrationHealth,
    // Outcome (3)
    create_outcome: createOutcomeTool,
    update_outcome: updateOutcomeTool,
    list_outcomes: listOutcomesTool,
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Return all 41 tools as array (with patched schemas for OpenAI API compat)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  return patchToolSchemas(Object.values(toolMap))
}

/**
 * Create Captain tools as a named map — used by subagents to pick tool subsets.
 * Same tools, same params, just indexed by name for selective access.
 */
export function createCaptainToolsMap(params: CaptainToolParams): Record<string, ReturnType<typeof tool>> {
  const { orgId } = params
  // Re-use createCaptainTools but we need the map. To avoid duplicating the
  // entire function, we call it and reconstruct the map from tool.name.
  const allTools = createCaptainTools(params)
  const map: Record<string, ReturnType<typeof tool>> = {}
  for (const t of allTools) {
    map[t.name] = t
  }
  return map
}
