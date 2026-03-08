// ─── Meeting Notification ─────────────────────────────────────────────────────
// Sends Slack DM with meeting summary after AI processing completes.
// Used by both the webhook handler and the cron job.

import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { buildAgentTextBlocks } from '@/lib/slack/blocks'

/**
 * Send Slack DM with meeting summary to the org's Slack-connected user.
 * Silently returns if Slack isn't configured, notifications are disabled,
 * or any lookup fails.
 */
export async function sendMeetingNotification(meetingId: string): Promise<void> {
  const admin = createAdminClient() as any // meeting tables not in generated types yet

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

    console.log(`[meeting-notification] Slack DM sent for ${meetingId}`)
  } catch (slackErr) {
    console.error(`[meeting-notification] Slack DM failed for ${connectedUser.email}:`, slackErr)
  }
}
