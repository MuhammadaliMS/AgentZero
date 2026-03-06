import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { runWeeklyTuning } from '@/lib/intelligence/learning-loop'
import { recordWeeklyMeasurement, evaluateRolloutAdvancement } from '@/lib/agent/runtime/rollout-manager'
import { runMemoryCurator } from '@/lib/graph/strategic-memory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * GET /api/cron/weekly-tuning
 * Weekly: learning loop tuning + rollout measurement + memory curation.
 * Cron: Sundays at 3:00 UTC.
 */
export async function GET(request: Request) {
  // Auth: verify cron secret — reject if env var is missing or empty
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[WeeklyTuning] CRON_SECRET is not configured')
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${cronSecret}`
  if (
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  // Get all orgs
  const { data: orgs, error } = await supabase
    .from('organizations')
    .select('id')

  if (error || !orgs) {
    console.error('[WeeklyTuning] Failed to fetch orgs:', error?.message)
    return NextResponse.json({ error: 'Failed to fetch orgs' }, { status: 500 })
  }

  const results: Array<{ orgId: string; status: string; details?: unknown }> = []

  for (const org of orgs) {
    try {
      // 1. Run learning loop tuning
      const tuning = await runWeeklyTuning(org.id)

      // 2. Record rollout measurement
      const measurement = await recordWeeklyMeasurement(org.id)

      // 3. Evaluate rollout advancement
      const advancement = await evaluateRolloutAdvancement(org.id)

      // 4. Run memory curator
      const curation = await runMemoryCurator(org.id)

      results.push({
        orgId: org.id,
        status: 'ok',
        details: {
          tuningProposals: tuning?.proposals.length ?? 0,
          tuningApplied: tuning?.appliedChanges.length ?? 0,
          measurement: measurement ? 'recorded' : 'skipped',
          rolloutAdvancement: advancement.reason,
          curation,
        },
      })
    } catch (err) {
      console.error(`[WeeklyTuning] Error for org ${org.id}:`, err)
      results.push({ orgId: org.id, status: 'error' })
    }
  }

  console.log(`[WeeklyTuning] Processed ${results.length} orgs`)
  return NextResponse.json({ results })
}
