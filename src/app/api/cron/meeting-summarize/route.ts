import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { buildAgentTextBlocks } from '@/lib/slack/blocks'
import { processAllPendingMeetings } from '@/lib/intelligence/meeting-processor'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Cron: Meeting Summarize
 *
 * Polls for meetings in 'processing' / 'transcribing' status and runs the
 * AI summarization pipeline. Same pattern as morning-brief:
 * responds immediately, heavy work runs via waitUntil.
 *
 * Schedule: Every 2 minutes (or triggered via webhook for immediate processing).
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

  waitUntil(runMeetingSummarizeBackground())

  return NextResponse.json({ ok: true, status: 'accepted' })
}

async function runMeetingSummarizeBackground() {
  const startTime = Date.now()

  try {
    // 1. Process all pending meetings
    const { processed, succeeded, failed, results } = await processAllPendingMeetings()

    if (processed === 0) return

    console.log(
      `[meeting-summarize] Processed ${processed} meetings: ` +
      `${succeeded} succeeded, ${failed} failed (${Date.now() - startTime}ms)`
    )

    // 2. Send Slack notifications for completed meetings
    const admin = createAdminClient() as any // meeting tables not in generated types yet

    for (const result of results) {
      if (result.status !== 'completed') continue

      try {
        await sendMeetingNotification(admin, result.meetingId)
      } catch (err) {
        console.error(
          `[meeting-summarize] Notification failed for ${result.meetingId}:`,
          (err as Error).message
        )
      }
    }
  } catch (err) {
    console.error('[meeting-summarize] Background run failed:', (err as Error).message)
  }
}

/**
 * Send Slack DM with meeting summary to all org members.
 */
async function sendMeetingNotification(
  admin: any, // meeting tables not in generated types yet
  meetingId: string
): Promise<void> {
  // Fetch meeting + summary
  const { data: meeting } = await admin
    .from('meetings')
    .select('id, org_id, title, scheduled_start, participants')
    .eq('id', meetingId)
    .single()

  if (!meeting) return

  const { data: summary } = await admin
    .from('meeting_summaries')
    .select('tldr, executive_summary')
    .eq('meeting_id', meetingId)
    .single()

  if (!summary) return

  // Fetch action items count
  const { count: actionCount } = await admin
    .from('meeting_action_items')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meetingId)
    .eq('status', 'open')

  const { count: decisionCount } = await admin
    .from('meeting_decisions')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meetingId)

  // Check bot config for notification preferences
  const { data: botConfig } = await admin
    .from('meeting_bot_config')
    .select('notify_via_slack')
    .eq('org_id', meeting.org_id)
    .maybeSingle()

  if (botConfig && !botConfig.notify_via_slack) return

  // Get Slack client
  const slackClient = await getSlackClient(meeting.org_id)
  if (!slackClient) return

  // Build message
  const dateLabel = meeting.scheduled_start
    ? new Date(meeting.scheduled_start).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : 'Unknown date'

  const messageText = [
    `*${summary.tldr}*`,
    '',
    summary.executive_summary,
    '',
    `_${actionCount ?? 0} action item${(actionCount ?? 0) !== 1 ? 's' : ''} · ${decisionCount ?? 0} decision${(decisionCount ?? 0) !== 1 ? 's' : ''}_`,
  ].join('\n')

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()

  // Send only to the person who connected Slack
  const { data: slackIntegration } = await admin
    .from('organization_integrations')
    .select('connected_by, integrations!inner(key)')
    .eq('org_id', meeting.org_id)
    .eq('integrations.key', 'slack')
    .eq('is_active', true)
    .maybeSingle()

  if (!slackIntegration?.connected_by) return

  const { data: connectedUser } = await admin
    .from('profiles')
    .select('email')
    .eq('id', slackIntegration.connected_by)
    .single()

  if (!connectedUser?.email) return

  try {
    const userResult = await slackClient.users.lookupByEmail({ email: connectedUser.email })
    if (!userResult.user?.id) return

    const conversation = await slackClient.conversations.open({ users: userResult.user.id })
    if (!conversation.channel?.id) return

    const blocks = buildAgentTextBlocks({
      header: `🎙️ Meeting Summary — ${meeting.title} (${dateLabel})`,
      text: messageText,
      footerText: `Captain • Meeting Bot`,
      appUrl: appUrl ? `${appUrl}/meetings/${meetingId}` : undefined,
    })

    await slackClient.chat.postMessage({
      channel: conversation.channel.id,
      text: `🎙️ Meeting Summary — ${meeting.title}`,
      blocks,
    })
  } catch (slackErr) {
    console.error(`[meeting-summarize] Slack DM failed for ${connectedUser.email}:`, slackErr)
  }
}
