import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runGhostAgentDeep } from '@/lib/intelligence/ghost-agent'
import { logWorkerExecution, completeWorkerExecution } from '@/lib/agent/hooks'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * Cron: Ghost Agent — Daily Deep Pass
 * Schedule: 0 2 * * * (2 AM UTC)
 *
 * Runs the full ghost agent analysis for each org:
 * - Expire stale insights
 * - Velocity spike detection
 * - Co-occurrence patterns
 * - Orphaned/stale entity detection
 * - Utility score recomputation
 * - Decay cycle
 * - Compression engine
 * - Route insights to actions
 *
 * All pure SQL — zero LLM calls.
 */
export async function GET(request: NextRequest) {
  // Auth check
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Get all organizations with onboarded users
  const { data: orgs } = await admin
    .from('profiles')
    .select('org_id')
    .not('onboarded_at', 'is', null)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 })
  }

  const uniqueOrgIds = [...new Set(orgs.map(p => p.org_id))]

  let processed = 0
  const errors: string[] = []
  const results: Array<{ orgId: string; result: Record<string, unknown> }> = []

  for (const orgId of uniqueOrgIds) {
    const executionId = await logWorkerExecution({
      org_id: orgId,
      worker: 'ghost-agent-deep',
      trigger: 'cron',
      input_summary: 'Daily deep pass',
      status: 'running',
    })

    try {
      const result = await runGhostAgentDeep(orgId)

      if (executionId) {
        await completeWorkerExecution(executionId, {
          status: 'completed',
          output_summary: `expired=${result.expired} spikes=${result.velocitySpikes} patterns=${result.coOccurrencePatterns} routed=${result.routing.routed} decay=${result.decayCycles} compression=${result.compression.patternsCreated}`,
          duration_ms: result.durationMs,
        })
      }

      processed++
      results.push({ orgId, result: result as unknown as Record<string, unknown> })

      console.log(
        `[ghost-agent:deep] org=${orgId}: expired=${result.expired} spikes=${result.velocitySpikes} patterns=${result.coOccurrencePatterns} routed=${result.routing.routed} utility=${result.utilityUpdated} decay=${result.decayCycles} compression=${result.compression.patternsCreated} (${result.durationMs}ms)`
      )
    } catch (err) {
      const errorMsg = `[ghost-agent:deep] Error for org ${orgId}: ${(err as Error).message}`
      console.error(errorMsg)
      errors.push(errorMsg)

      if (executionId) {
        await completeWorkerExecution(executionId, {
          status: 'failed',
          error: (err as Error).message,
          duration_ms: 0,
        })
      }
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    total_orgs: uniqueOrgIds.length,
    errors: errors.length > 0 ? errors : undefined,
  })
}
