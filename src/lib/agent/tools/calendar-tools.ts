import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

/**
 * Calendar tools — timezone-aware date computation + real free-slot calculation.
 *
 * @param orgId    — org for token lookup
 * @param timezone — IANA timezone string from user profile (e.g. "America/New_York").
 *                   Falls back to "UTC" if null/undefined.
 */
export function createCalendarTools(orgId: string, timezone?: string | null) {
  const tz = timezone || 'UTC'

  /**
   * Compute the start and end of "today" in the user's timezone.
   * Returns ISO strings in UTC (which is what Google/Microsoft APIs expect).
   */
  function getTodayBounds(): { startOfDay: string; endOfDay: string } {
    // Get current time formatted in user's TZ to extract date components
    const now = new Date()
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)

    const year = parseInt(parts.find(p => p.type === 'year')!.value)
    const month = parseInt(parts.find(p => p.type === 'month')!.value) - 1
    const day = parseInt(parts.find(p => p.type === 'day')!.value)

    // Build start/end in the user's timezone by using a known offset approach.
    // Create a date string in the user's TZ and convert to ISO via Date parsing.
    const startStr = new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
    startStr.setFullYear(year, month, day)
    startStr.setHours(0, 0, 0, 0)

    const endStr = new Date(startStr)
    endStr.setDate(endStr.getDate() + 1)

    // Convert back to UTC ISO strings using the timezone offset
    const startOfDay = tzDateToUTC(year, month, day, 0, 0, tz)
    const endOfDay = tzDateToUTC(year, month, day + 1, 0, 0, tz)

    return { startOfDay, endOfDay }
  }

  /**
   * Compute bounds for N days from today in the user's timezone.
   */
  function getDaysBounds(daysAhead: number): { start: string; end: string } {
    const { startOfDay } = getTodayBounds()
    const startDate = new Date(startOfDay)
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + daysAhead)
    return { start: startDate.toISOString(), end: endDate.toISOString() }
  }

  const getTodayEvents = tool(
    'get_today_events',
    `Get calendar events for today from the connected calendar (Google Calendar or Microsoft Calendar). Uses the user's timezone (${tz}).`,
    {},
    async () => {
      const { startOfDay, endOfDay } = getTodayBounds()
      return await fetchCalendarEvents(orgId, startOfDay, endOfDay, tz)
    },
    { annotations: { title: 'Get Today Events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const getWeekEvents = tool(
    'get_week_events',
    `Get calendar events for the upcoming days from the connected calendar. Uses the user's timezone (${tz}).`,
    {
      days_ahead: z.number().optional().default(7),
    },
    async (args) => {
      const { start, end } = getDaysBounds(args.days_ahead)
      return await fetchCalendarEvents(orgId, start, end, tz)
    },
    { annotations: { title: 'Get Week Events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const findFreeSlots = tool(
    'find_free_slots',
    `Find free time slots in the calendar for scheduling. Actually computes gaps between events within work hours. Returns concrete available time blocks in the user's timezone (${tz}).`,
    {
      duration_minutes: z.number().default(30).describe('Meeting duration in minutes'),
      days_ahead: z.number().default(3).describe('Number of days to look ahead'),
      work_start_hour: z.number().default(9).describe('Start of work day (24h format, in user timezone)'),
      work_end_hour: z.number().default(17).describe('End of work day (24h format, in user timezone)'),
    },
    async (args) => {
      const { start, end } = getDaysBounds(args.days_ahead)
      const eventsResult = await fetchCalendarEvents(orgId, start, end, tz)
      const eventsText = eventsResult.content[0]?.text || '[]'

      try {
        const events = JSON.parse(eventsText)

        // If error message (not an array), pass through
        if (!Array.isArray(events)) {
          return eventsResult
        }

        // Compute free slots
        const freeSlots = computeFreeSlots(
          events,
          args.days_ahead,
          args.duration_minutes,
          args.work_start_hour,
          args.work_end_hour,
          tz
        )

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              free_slots: freeSlots,
              parameters: {
                duration_minutes: args.duration_minutes,
                work_hours: `${args.work_start_hour}:00 – ${args.work_end_hour}:00 (${tz})`,
                days_ahead: args.days_ahead,
              },
              total_slots_found: freeSlots.length,
            }, null, 2),
          }],
        }
      } catch {
        return eventsResult
      }
    },
    { annotations: { title: 'Find Free Slots', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [getTodayEvents, getWeekEvents, findFreeSlots]
}

// ─── Free Slot Computation ─────────────────────────────────────────────────

interface CalendarEvent {
  start?: string
  end?: string
}

interface FreeSlot {
  date: string
  day: string
  start: string
  end: string
  duration_minutes: number
}

function computeFreeSlots(
  events: CalendarEvent[],
  daysAhead: number,
  durationMinutes: number,
  workStartHour: number,
  workEndHour: number,
  tz: string
): FreeSlot[] {
  const freeSlots: FreeSlot[] = []
  const now = new Date()

  for (let d = 0; d < daysAhead; d++) {
    // Get the date in user's timezone
    const dayDate = new Date(now)
    dayDate.setDate(dayDate.getDate() + d)

    const dayStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(dayDate)

    const year = parseInt(dayStr.find(p => p.type === 'year')!.value)
    const month = parseInt(dayStr.find(p => p.type === 'month')!.value) - 1
    const day = parseInt(dayStr.find(p => p.type === 'day')!.value)

    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(dayDate)
    const dateLabel = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

    // Skip weekends
    const dow = new Date(dayDate.toLocaleString('en-US', { timeZone: tz })).getDay()
    if (dow === 0 || dow === 6) continue

    // Work window in UTC
    const workStart = new Date(tzDateToUTC(year, month, day, workStartHour, 0, tz))
    const workEnd = new Date(tzDateToUTC(year, month, day, workEndHour, 0, tz))

    // Skip if work day already ended (for today)
    if (workEnd <= now) continue

    // Effective start is max(workStart, now) for today
    const effectiveStart = d === 0 && workStart < now ? now : workStart

    // Filter events for this day (overlapping with work window)
    const dayEvents = events
      .filter(e => {
        if (!e.start || !e.end) return false
        const eStart = new Date(e.start)
        const eEnd = new Date(e.end)
        return eStart < workEnd && eEnd > workStart
      })
      .map(e => ({
        start: new Date(Math.max(new Date(e.start!).getTime(), workStart.getTime())),
        end: new Date(Math.min(new Date(e.end!).getTime(), workEnd.getTime())),
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime())

    // Find gaps
    let cursor = effectiveStart > workStart ? effectiveStart : workStart

    for (const evt of dayEvents) {
      if (evt.start > cursor) {
        const gapMinutes = Math.floor((evt.start.getTime() - cursor.getTime()) / 60000)
        if (gapMinutes >= durationMinutes) {
          freeSlots.push({
            date: dateLabel,
            day: dayName,
            start: formatTimeInTz(cursor, tz),
            end: formatTimeInTz(evt.start, tz),
            duration_minutes: gapMinutes,
          })
        }
      }
      // Advance cursor past this event
      if (evt.end > cursor) cursor = evt.end
    }

    // Gap after last event until work end
    if (cursor < workEnd) {
      const gapMinutes = Math.floor((workEnd.getTime() - cursor.getTime()) / 60000)
      if (gapMinutes >= durationMinutes) {
        freeSlots.push({
          date: dateLabel,
          day: dayName,
          start: formatTimeInTz(cursor, tz),
          end: formatTimeInTz(workEnd, tz),
          duration_minutes: gapMinutes,
        })
      }
    }
  }

  return freeSlots
}

// ─── Timezone Helpers ───────────────────────────────────────────────────────

/**
 * Convert a date/time specified in a given timezone to a UTC ISO string.
 * E.g. tzDateToUTC(2024, 0, 15, 9, 0, 'America/New_York') → UTC equiv of 9 AM ET on Jan 15
 */
function tzDateToUTC(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string
): string {
  // Create a reference date and use Intl to find the UTC offset
  // Build an approximate date
  const approx = new Date(Date.UTC(year, month, day, hour, minute))

  // Format in the target timezone to find the actual local time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })

  // Binary search for the correct UTC time that maps to the desired local time.
  // Start with a rough estimate and adjust.
  const parts = formatter.formatToParts(approx)
  const localHour = parseInt(parts.find(p => p.type === 'hour')!.value)
  const localDay = parseInt(parts.find(p => p.type === 'day')!.value)

  // Rough offset in hours
  let offsetMs = 0
  if (localDay !== day || localHour !== hour) {
    // The approximate date in the target TZ differs from what we want.
    // Compute the difference and adjust.
    const localDate = new Date(
      parseInt(parts.find(p => p.type === 'year')!.value),
      parseInt(parts.find(p => p.type === 'month')!.value) - 1,
      parseInt(parts.find(p => p.type === 'day')!.value),
      parseInt(parts.find(p => p.type === 'hour')!.value),
      parseInt(parts.find(p => p.type === 'minute')!.value),
    )
    const targetDate = new Date(year, month, day, hour, minute)
    offsetMs = targetDate.getTime() - localDate.getTime()
  }

  const result = new Date(approx.getTime() + offsetMs)
  return result.toISOString()
}

/**
 * Format a Date as "HH:MM AM/PM" in the given timezone.
 */
function formatTimeInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

// ─── Calendar API Helpers ──────────────────────────────────────────────────

async function fetchCalendarEvents(orgId: string, timeMin: string, timeMax: string, tz: string) {
  // Try Google Calendar
  let tokens = await TokenManager.getTokens(orgId, 'google_calendar')
  if (!tokens) {
    tokens = await TokenManager.getTokens(orgId, 'gmail')
  }

  if (tokens) {
    try {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        timeZone: tz,
      })

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      )

      if (response.ok) {
        const data = await response.json()
        const events = (data.items || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          title: e.summary || '(no title)',
          start: (e.start as { dateTime?: string; date?: string })?.dateTime || (e.start as { date?: string })?.date,
          end: (e.end as { dateTime?: string; date?: string })?.dateTime || (e.end as { date?: string })?.date,
          location: e.location || undefined,
          description: e.description ? (e.description as string).slice(0, 200) : undefined,
          attendees: ((e.attendees as Array<{ email: string; responseStatus?: string }>) || [])
            .slice(0, 10)
            .map(a => ({ email: a.email, status: a.responseStatus })),
          status: (e.status as string) || undefined,
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }] }
      }

      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('google_calendar', 'Google Calendar')
      }

      return { content: [{ type: 'text' as const, text: `Google Calendar error: ${response.status}` }] }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Google Calendar error: ${(e as Error).message}` }] }
    }
  }

  // Try Microsoft Calendar
  tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
  if (tokens) {
    try {
      // Microsoft Graph expects timezone via Prefer header
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${timeMin}&endDateTime=${timeMax}&$select=subject,start,end,location,attendees,showAs&$orderby=start/dateTime&$top=50`,
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Prefer: `outlook.timezone="${tz}"`,
          },
        }
      )

      if (response.ok) {
        const data = await response.json()
        const events = (data.value || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          title: e.subject || '(no title)',
          start: (e.start as { dateTime?: string })?.dateTime,
          end: (e.end as { dateTime?: string })?.dateTime,
          location: (e.location as { displayName?: string })?.displayName || undefined,
          attendees: ((e.attendees as Array<{ emailAddress: { address: string }; status?: { response?: string } }>) || [])
            .slice(0, 10)
            .map(a => ({ email: a.emailAddress.address, status: a.status?.response })),
          showAs: e.showAs || undefined,
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }] }
      }

      // ✅ Fixed: was returning google_calendar for Microsoft auth failures
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('microsoft_365', 'Microsoft 365')
      }

      return { content: [{ type: 'text' as const, text: `Microsoft Calendar error: ${response.status}` }] }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Microsoft Calendar error: ${(e as Error).message}` }] }
    }
  }

  return buildIntegrationRequiredResult('google_calendar', 'Google Calendar')
}
