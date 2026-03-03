import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runPatrolScan } from '@/lib/intelligence/patrol-scanner'
import { detectActedOnCommitments, recomputeSignalWeights } from '@/lib/intelligence/feedback-tracker'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * Background Patrol Cron — runs every 2 hours.
 *
 * 1. Scans commitments, entities, actions, blockers for each org.
 * 2. Computes risk scores and auto-transitions.
 * 3. Creates/updates patrol_findings.
 * 4. Detects acted-on commitments and recomputes feedback weights.
 *
 * Zero LLM calls — all pure DB queries + scoring logic.
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

  // Get all orgs with onboarded users
  const { data: orgs } = await admin
    .from('organizations')
    .select('id')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, orgsProcessed: 0 })
  }

  const results: Array<{
    orgId: string
    patrol: unknown
    feedbackDetected: number
    weightsUpdated: number
    error?: string
  }> = []

  for (const org of orgs) {
    try {
      // Check if org has any onboarded users (skip empty orgs)
      const { count } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org.id)
        .not('onboarded_at', 'is', null)

      if (!count || count === 0) continue

      // 1. Run patrol scan
      const patrolResult = await runPatrolScan(admin, org.id)

      // 2. Detect acted-on commitments
      const feedbackDetected = await detectActedOnCommitments(admin, org.id)

      // 3. Recompute signal weights
      const weightsUpdated = await recomputeSignalWeights(admin, org.id)

      results.push({
        orgId: org.id,
        patrol: patrolResult,
        feedbackDetected,
        weightsUpdated,
      })
    } catch (err) {
      console.error(`[patrol] Error for org ${org.id}:`, err)
      results.push({
        orgId: org.id,
        patrol: {} as Record<string, number>,
        feedbackDetected: 0,
        weightsUpdated: 0,
        error: (err as Error).message,
      })
    }
  }

  return NextResponse.json({
    ok: true,
    orgsProcessed: results.length,
    results,
  })
}
