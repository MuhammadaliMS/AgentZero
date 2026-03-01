import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  let nudgesSent = 0

  // 1. Nudge users with incomplete onboarding
  const { data: incompleteOnboarding } = await admin
    .from('onboarding_state')
    .select('user_id, org_id, steps, profiles!inner(email, full_name)')
    .eq('is_complete', false)

  if (incompleteOnboarding) {
    for (const onboarding of incompleteOnboarding) {
      const profile = onboarding.profiles as unknown as { email: string; full_name: string | null }
      const slackClient = await getSlackClient(onboarding.org_id)
      if (!slackClient || !profile.email) continue

      // Check which integrations are missing
      const steps = (onboarding.steps as Array<{ name: string; status: string }>) || []
      const incomplete = steps.filter((s) => s.status !== 'completed')

      if (incomplete.length === 0) continue

      const message = `Hey${profile.full_name ? ` ${profile.full_name.split(' ')[0]}` : ''}! You have ${incomplete.length} integration${incomplete.length > 1 ? 's' : ''} left to connect. The more tools I can access, the more I can help you. Visit your dashboard to finish setup.`

      try {
        const userResult = await slackClient.users.lookupByEmail({ email: profile.email })
        if (userResult.user?.id) {
          const conversation = await slackClient.conversations.open({ users: userResult.user.id })
          if (conversation.channel?.id) {
            await slackClient.chat.postMessage({
              channel: conversation.channel.id,
              text: message,
            })

            // Record the nudge
            await admin.from('nudges').insert({
              org_id: onboarding.org_id,
              user_id: onboarding.user_id,
              type: 'onboarding_incomplete',
              title: 'Complete your setup',
              content: message,
              priority: 'medium',
              status: 'sent',
              sent_at: new Date().toISOString(),
            })

            nudgesSent++
          }
        }
      } catch {
        // Skip individual errors
      }
    }
  }

  // 2. Nudge for pending actions older than 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: pendingActions } = await admin
    .from('actions')
    .select('id, org_id, user_id, title, priority, profiles!inner(email, full_name)')
    .eq('status', 'pending')
    .lt('created_at', oneDayAgo)

  if (pendingActions) {
    for (const action of pendingActions) {
      const profile = action.profiles as unknown as { email: string; full_name: string | null }
      const slackClient = await getSlackClient(action.org_id)
      if (!slackClient || !profile.email) continue

      const priorityPrefix = action.priority === 'critical' ? ':rotating_light: ' : ''
      const message = `${priorityPrefix}Reminder: *${action.title}* is still pending your approval. Please review when you get a chance.`

      try {
        const userResult = await slackClient.users.lookupByEmail({ email: profile.email })
        if (userResult.user?.id) {
          const conversation = await slackClient.conversations.open({ users: userResult.user.id })
          if (conversation.channel?.id) {
            await slackClient.chat.postMessage({
              channel: conversation.channel.id,
              text: message,
            })

            await admin.from('nudges').insert({
              org_id: action.org_id,
              user_id: action.user_id,
              type: 'pending_action',
              title: `Pending: ${action.title}`,
              content: message,
              priority: action.priority || 'medium',
              status: 'sent',
              sent_at: new Date().toISOString(),
              action_id: action.id,
            })

            nudgesSent++
          }
        }
      } catch {
        // Skip individual errors
      }
    }
  }

  return NextResponse.json({ ok: true, nudgesSent })
}
