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
      // Only send EOD wrap when it's 4–7 PM in the user's local timezone.
      const tz = profile.timezone ?? 'UTC'
      const localHour = getLocalHour(tz)
      if (localHour < 16 || localHour >= 19) {
        skipped++
        continue
      }

      // ── Deduplication ─────────────────────────────────────────────────────
      // Skip if an EOD wrap was already sent today in the user's timezone.
      const todayLocal = getLocalDateString(tz)
      const { data: existing } = await admin
        .from('briefs')
        .select('id')
        .eq('user_id', profile.id)
        .eq('type', 'eod')
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

      // ── Generate EOD wrap via agent ────────────────────────────────────────
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
        message: `Generate ${firstName}'s end-of-day wrap for ${dateLabel}. Summarize: what was accomplished today, commitments or deliverables completed, items carrying forward to tomorrow, any pending actions still open (and who's blocking them), and a 1-sentence preview of tomorrow's priorities. Keep it under 250 words.`,
        conversationId: `cron-eod-${profile.id}-${todayLocal}`,
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
          type: 'eod',
          title: `EOD Wrap — ${dateLabel}`,
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
                header: `🌙 EOD Wrap — ${dateLabel}`,
                text: fullResponse,
                footerText: `Captain • Sent at ${now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' })} ${tz}`,
                appUrl: appUrl ? `${appUrl}/chat` : undefined,
              })

              const msgResult = await slackClient.chat.postMessage({
                channel: conversation.channel.id,
                text: `🌙 EOD Wrap — ${dateLabel}`,
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
          console.error(`[eod-wrap] Slack DM failed for ${profile.email}:`, slackErr)
        }
      }

      processed++
    } catch (err) {
      const errorMsg = `[eod-wrap] Error for user ${profile.id}: ${(err as Error).message}`
      console.error(errorMsg)
      errors.push(errorMsg)
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors })
}
