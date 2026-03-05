import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { runCaptainWithSDK } from '@/lib/agent/sdk-switch'
import { buildAgentTextBlocks } from '@/lib/slack/blocks'
import type { Json } from '@/types/database'
import {
  gatherWorkerViews,
  buildBriefPrompt,
  extractMetrics,
  getYesterdayMetrics,
} from '@/lib/intelligence/brief-synthesizer'
import { runExtractionPipeline } from '@/lib/graph/extraction-pipeline'

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

/**
 * Cron: EOD Wrap
 *
 * Uses waitUntil to respond immediately (so cron-job.org doesn't timeout)
 * while the heavy LLM work continues in the background.
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Respond immediately — heavy work runs in background via waitUntil
  waitUntil(runEodWrapBackground())

  return NextResponse.json({ ok: true, status: 'accepted' })
}

async function runEodWrapBackground() {
  const admin = createAdminClient()

  // Get all onboarded profiles with timezone info
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, org_id, email, full_name, timezone')
    .not('onboarded_at', 'is', null)

  if (!profiles || profiles.length === 0) return

  for (const profile of profiles) {
    try {
      // ── Timezone info ────────────────────────────────────────────────────
      const tz = profile.timezone ?? 'UTC'

      // ── Deduplication ─────────────────────────────────────────────────────
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

      if (existing) continue

      // ── Slack client ───────────────────────────────────────────────────────
      const slackClient = await getSlackClient(profile.org_id)
      if (!slackClient) continue

      // ── Generate EOD wrap via agent (with cross-worker synthesis) ─────────
      const firstName = profile.full_name?.split(' ')[0] ?? 'there'
      const now = new Date()
      const dateLabel = now.toLocaleDateString('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })

      const workerViews = await gatherWorkerViews(admin, profile.org_id)
      const yesterdayMetrics = await getYesterdayMetrics(admin, profile.id, 'eod')
      const enrichedPrompt = buildBriefPrompt('eod', workerViews, yesterdayMetrics, firstName, dateLabel)
      const briefMetrics = extractMetrics(workerViews)

      let fullResponse = ''
      const agentStream = runCaptainWithSDK({
        orgId: profile.org_id,
        userId: profile.id,
        message: enrichedPrompt,
        conversationId: randomUUID(),
      })

      for await (const event of agentStream) {
        if (event.type === 'text' && event.content) {
          fullResponse += event.content
        }
      }

      if (!fullResponse) continue

      // ── Store in DB ─────────────────────────────────────────────────────────
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

      // ── Extract entities from wrap for knowledge graph ──────────────────────
      try {
        await runExtractionPipeline({
          orgId: profile.org_id,
          conversationId: randomUUID(),
          messageContent: fullResponse,
          role: 'assistant',
        })
      } catch (extractErr) {
        console.error(`[eod-wrap] Extraction failed for ${profile.id}:`, extractErr)
      }

      console.log(`[eod-wrap] Completed for ${profile.id}`)
    } catch (err) {
      console.error(`[eod-wrap] Error for user ${profile.id}: ${(err as Error).message}`)
    }
  }
}
