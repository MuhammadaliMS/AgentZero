import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { runCaptain } from '@/lib/agent/orchestrator'
import { buildAgentTextBlocks } from '@/lib/slack/blocks'
import type { Json } from '@/types/database'
import {
  gatherWorkerViews,
  buildBriefPrompt,
  extractMetrics,
  getYesterdayMetrics,
} from '@/lib/intelligence/brief-synthesizer'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

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
  const diagnostics: Array<{ userId: string; status: string; reason?: string }> = []

  for (const profile of profiles) {
    try {
      // ── Timezone info ────────────────────────────────────────────────────
      const tz = profile.timezone ?? 'UTC'

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
        diagnostics.push({ userId: profile.id, status: 'skipped', reason: `dedup: brief already exists for ${todayLocal}` })
        continue
      }

      // ── Slack client ───────────────────────────────────────────────────────
      const slackClient = await getSlackClient(profile.org_id)
      if (!slackClient) {
        skipped++
        diagnostics.push({ userId: profile.id, status: 'skipped', reason: `no slack client for org ${profile.org_id}` })
        continue
      }

      // ── Generate brief via agent (with cross-worker synthesis) ────────────
      const firstName = profile.full_name?.split(' ')[0] ?? 'there'
      const now = new Date()
      const dateLabel = now.toLocaleDateString('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })

      // Gather cross-worker data (pure DB queries, no LLM cost)
      const workerViews = await gatherWorkerViews(admin, profile.org_id)
      const yesterdayMetrics = await getYesterdayMetrics(admin, profile.id, 'morning')
      const enrichedPrompt = buildBriefPrompt('morning', workerViews, yesterdayMetrics, firstName, dateLabel)
      const briefMetrics = extractMetrics(workerViews)

      let fullResponse = ''
      let agentError = ''
      try {
        const agentStream = runCaptain({
          orgId: profile.org_id,
          userId: profile.id,
          message: enrichedPrompt,
          conversationId: randomUUID(),
        })

        for await (const event of agentStream) {
          if (event.type === 'text' && event.content) {
            fullResponse += event.content
          }
          if (event.type === 'error' && event.content) {
            agentError = event.content
            console.error(`[morning-brief] Captain error event for ${profile.id}: ${event.content}`)
          }
        }
      } catch (agentErr) {
        agentError = (agentErr as Error).message
        console.error(`[morning-brief] Captain threw for ${profile.id}:`, agentErr)
      }

      if (!fullResponse) {
        skipped++
        diagnostics.push({
          userId: profile.id,
          status: 'skipped',
          reason: agentError
            ? `Captain error: ${agentError}`
            : 'empty response from Captain agent (no text events)',
        })
        continue
      }

      // ── Store in DB (with metrics for next-day comparison) ─────────────────
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
          metrics: briefMetrics as unknown as Json,
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
      diagnostics.push({ userId: profile.id, status: 'sent' })
    } catch (err) {
      const errorMsg = `[morning-brief] Error for user ${profile.id}: ${(err as Error).message}`
      console.error(errorMsg)
      errors.push(errorMsg)
      diagnostics.push({ userId: profile.id, status: 'error', reason: (err as Error).message })
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors, diagnostics })
}
