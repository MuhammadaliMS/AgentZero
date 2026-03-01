import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createCalendarTools(orgId: string) {
  const getTodayEvents = tool(
    'get_today_events',
    'Get calendar events for today from the connected calendar (Google Calendar or Microsoft Calendar).',
    {},
    async () => {
      const now = new Date()
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

      return await fetchCalendarEvents(orgId, startOfDay, endOfDay)
    },
    { annotations: { title: 'Get Today Events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const getWeekEvents = tool(
    'get_week_events',
    'Get calendar events for the current week.',
    {
      days_ahead: z.number().optional().default(7),
    },
    async (args) => {
      const now = new Date()
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const endDate = new Date(now.getTime() + args.days_ahead * 24 * 60 * 60 * 1000).toISOString()

      return await fetchCalendarEvents(orgId, startOfDay, endDate)
    },
    { annotations: { title: 'Get Week Events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const findFreeSlots = tool(
    'find_free_slots',
    'Find free time slots in the calendar for a given duration over the next N days.',
    {
      duration_minutes: z.number().default(30).describe('Meeting duration in minutes'),
      days_ahead: z.number().default(3).describe('Number of days to look ahead'),
      work_start_hour: z.number().default(9).describe('Start of work day (24h format)'),
      work_end_hour: z.number().default(17).describe('End of work day (24h format)'),
    },
    async (args) => {
      const now = new Date()
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const endDate = new Date(now.getTime() + args.days_ahead * 24 * 60 * 60 * 1000).toISOString()

      const eventsResult = await fetchCalendarEvents(orgId, startOfDay, endDate)
      const eventsText = eventsResult.content[0]?.text || '[]'

      // Parse events and find gaps
      try {
        const events = JSON.parse(eventsText)
        if (!Array.isArray(events) || events.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No events found — entire work schedule is free.' }] }
        }

        // Return events and let the LLM figure out free slots
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              events,
              parameters: {
                duration_minutes: args.duration_minutes,
                work_hours: `${args.work_start_hour}:00 - ${args.work_end_hour}:00`,
                days_ahead: args.days_ahead,
              },
              instruction: 'Analyze these events and identify free slots that fit the requested duration within work hours.',
            }, null, 2),
          }],
        }
      } catch {
        return { content: [{ type: 'text' as const, text: eventsText }] }
      }
    },
    { annotations: { title: 'Find Free Slots', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [getTodayEvents, getWeekEvents, findFreeSlots]
}

async function fetchCalendarEvents(orgId: string, timeMin: string, timeMax: string) {
  console.log(`[Tool:calendar] fetchCalendarEvents called: orgId=${orgId}, timeMin=${timeMin}, timeMax=${timeMax}`)
  // Try Google Calendar
  let tokens = await TokenManager.getTokens(orgId, 'google_calendar')
  console.log(`[Tool:calendar] google_calendar tokens: ${tokens ? 'present' : 'null'}`)
  if (!tokens) {
    tokens = await TokenManager.getTokens(orgId, 'gmail')
    console.log(`[Tool:calendar] gmail tokens fallback: ${tokens ? 'present' : 'null'}`)
  }

  if (tokens) {
    try {
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

      if (response.ok) {
        const data = await response.json()
        const events = (data.items || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          title: e.summary || '(no title)',
          start: (e.start as { dateTime?: string; date?: string })?.dateTime || (e.start as { date?: string })?.date,
          end: (e.end as { dateTime?: string; date?: string })?.dateTime || (e.end as { date?: string })?.date,
          location: e.location,
          description: e.description ? (e.description as string).slice(0, 200) : undefined,
          attendees: ((e.attendees as Array<{ email: string }>) || []).map(a => a.email).slice(0, 10),
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }] }
      }
      // Auth failure — tokens expired/revoked, trigger integration card
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('google_calendar', 'Google Calendar')
      }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Google Calendar error: ${(e as Error).message}` }] }
    }
  }

  // Try Microsoft Calendar
  tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
  if (tokens) {
    try {
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${timeMin}&endDateTime=${timeMax}&$select=subject,start,end,location,attendees&$orderby=start/dateTime`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      )

      if (response.ok) {
        const data = await response.json()
        const events = (data.value || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          title: e.subject || '(no title)',
          start: (e.start as { dateTime?: string })?.dateTime,
          end: (e.end as { dateTime?: string })?.dateTime,
          location: (e.location as { displayName?: string })?.displayName,
          attendees: ((e.attendees as Array<{ emailAddress: { address: string } }>) || []).map(a => a.emailAddress.address).slice(0, 10),
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }] }
      }
      // Auth failure — tokens expired/revoked, trigger integration card
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('google_calendar', 'Google Calendar')
      }
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Microsoft Calendar error: ${(e as Error).message}` }] }
    }
  }

  return buildIntegrationRequiredResult('google_calendar', 'Google Calendar')
}
