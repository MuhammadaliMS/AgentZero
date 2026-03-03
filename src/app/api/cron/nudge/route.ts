import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSlackClient } from '@/lib/slack/client'
import { runSmartNudge, buildBatchSlackMessage } from '@/lib/intelligence/nudge-engine'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * Smart Nudge Cron — runs 3x daily (9 AM, 12 PM, 3 PM UTC).
 *
 * Pipeline:
 *   1. Gather candidates from patrol findings + direct queries
 *   2. Score with urgency formula
 *   3. Apply 8-hour cooldown
 *   4. Batch by user
 *   5. Deliver via Slack DM
 *
 * Priority tiers:
 *   - critical + high: Every run (9, 12, 3)
 *   - medium: Noon run only
 *   - low: Monday noon only (weekly digest)
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Determine run mode based on current hour
  const now = new Date()
  const utcHour = now.getUTCHours()
  const dayOfWeek = now.getUTCDay() // 0 = Sunday, 1 = Monday
  const isNoon = utcHour === 12
  const isMonday = dayOfWeek === 1

  let mode: 'all' | 'noon' | 'monday_noon' = 'all'
  if (isNoon && isMonday) {
    mode = 'monday_noon'
  } else if (isNoon) {
    mode = 'noon'
  }

  // Get all orgs
  const { data: orgs } = await admin.from('organizations').select('id')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, mode, orgsProcessed: 0 })
  }

  let totalNudgesSent = 0
  let totalBatches = 0
  const errors: string[] = []

  for (const org of orgs) {
    try {
      // Check if org has onboarded users
      const { count } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org.id)
        .not('onboarded_at', 'is', null)

      if (!count || count === 0) continue

      // Run smart nudge pipeline
      const result = await runSmartNudge(admin, org.id, mode)

      // Deliver batches via Slack
      const batches = result.batches
      for (const batch of batches) {
        const slackClient = await getSlackClient(batch.orgId)
        if (!slackClient) continue

        // Get user email for Slack DM
        const { data: profile } = await admin
          .from('profiles')
          .select('email')
          .eq('id', batch.userId)
          .maybeSingle()

        if (!profile?.email) continue

        try {
          const userResult = await slackClient.users.lookupByEmail({ email: profile.email })
          if (!userResult.user?.id) continue

          const conversation = await slackClient.conversations.open({ users: userResult.user.id })
          if (!conversation.channel?.id) continue

          const message = buildBatchSlackMessage(batch)
          await slackClient.chat.postMessage({
            channel: conversation.channel.id,
            text: message,
          })

          // Mark nudges as sent
          for (const item of batch.items) {
            if (item.findingId) {
              // Find the nudge we just created and update it
              await admin
                .from('nudges')
                .update({ status: 'sent' as const, sent_at: new Date().toISOString() })
                .eq('org_id', batch.orgId)
                .eq('batch_id', batch.batchId)
                .eq('source_finding_id', item.findingId)
            }
          }

          // Also update nudges without findingId (e.g. onboarding)
          await admin
            .from('nudges')
            .update({ status: 'sent' as const, sent_at: new Date().toISOString() })
            .eq('org_id', batch.orgId)
            .eq('batch_id', batch.batchId)
            .eq('status', 'pending')

          totalNudgesSent += batch.items.length
          totalBatches++
        } catch (slackErr) {
          console.error(`[nudge] Slack DM failed for ${profile.email}:`, slackErr)
        }
      }
    } catch (err) {
      const msg = `[nudge] Error for org ${org.id}: ${(err as Error).message}`
      console.error(msg)
      errors.push(msg)
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    totalNudgesSent,
    totalBatches,
    errors: errors.length > 0 ? errors : undefined,
  })
}
