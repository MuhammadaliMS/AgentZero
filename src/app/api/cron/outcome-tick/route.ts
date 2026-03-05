/**
 * Outcome Tick — Bare step executor.
 *
 * Runs every 5 minutes. Zero LLM. Zero intelligence.
 * ONLY executes ready tool_call steps whose dependencies are met.
 * llm_reasoning steps are left for the hourly chief loop.
 *
 * This exists solely so unblock-to-resume latency stays under 5 min
 * instead of waiting up to 59 min for the next chief loop.
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { executeToolDirectly } from '@/lib/agent/planner/background-executor'
import { getNextExecutableSteps, updateStep } from '@/lib/agent/runtime/outcome-runtime'
import { reconcileOutcomeStatus } from '@/lib/agent/planner/step-executor'
import { EXTERNAL_TOOLS } from '@/lib/agent/planner/plan-validator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs) {
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 })
  }

  const MAX_STEPS_PER_ORG = 10
  const results: Array<{ orgId: string; stepsExecuted: number; errors: number }> = []

  for (const org of orgs) {
    const orgId = org.id
    let stepsExecuted = 0
    let errors = 0

    try {
      // Fetch all executing outcomes
      const { data: outcomes } = await supabase
        .from('outcomes')
        .select('id')
        .eq('org_id', orgId)
        .eq('status', 'executing')

      if (!outcomes || outcomes.length === 0) {
        results.push({ orgId, stepsExecuted: 0, errors: 0 })
        continue
      }

      for (const outcome of outcomes) {
        // Budget: stop if we've hit the per-org execution limit
        if (stepsExecuted >= MAX_STEPS_PER_ORG) break

        const outcomeId = outcome.id

        // Get active run
        const { data: runs } = await supabase
          .from('outcome_runs')
          .select('id')
          .eq('outcome_id', outcomeId)
          .eq('status', 'active')
          .limit(1)

        const runId = runs?.[0]?.id
        if (!runId) continue

        const readySteps = await getNextExecutableSteps(runId)

        for (const step of readySteps) {
          if (stepsExecuted >= MAX_STEPS_PER_ORG) break

          // Safety: never auto-execute external tools
          if (step.toolName && EXTERNAL_TOOLS.includes(step.toolName)) {
            if (step.status === 'pending') {
              await updateStep(step.id, { status: 'blocked', blockerType: 'approval_pending' }, orgId)
            }
            continue
          }

          // llm_reasoning steps are handled by the hourly chief loop, skip here
          if (step.actionType === 'llm_reasoning') {
            continue
          }

          // Only execute tool_call steps
          if (step.actionType === 'tool_call' && step.toolName) {
            try {
              const result = await executeToolDirectly(
                orgId,
                step.toolName,
                (step.toolArgs as Record<string, unknown>) ?? {},
                { timeoutMs: 30_000 }
              )
              await updateStep(step.id, {
                status: result.success ? 'completed' : 'failed',
                resultSummary: result.summary,
                errorMessage: result.error ?? null,
              }, orgId)
              if (result.success) stepsExecuted++
              else errors++
            } catch (err) {
              await updateStep(step.id, {
                status: 'failed',
                errorMessage: `Tick error: ${(err as Error).message}`,
              }, orgId)
              errors++
            }
            continue
          }

          // wait_input / wait_approval → mark blocked
          if (step.actionType === 'wait_input' || step.actionType === 'wait_approval') {
            if (step.status === 'pending') {
              await updateStep(step.id, {
                status: 'blocked',
                blockerType: step.actionType === 'wait_input' ? 'input_needed' : 'approval_pending',
              }, orgId)
            }
          }
        }

        // Reconcile outcome status after processing steps
        await reconcileOutcomeStatus(orgId, outcomeId, runId)
      }
    } catch (err) {
      console.error(`[outcome-tick] Error for org ${orgId}:`, err)
      errors++
    }

    results.push({ orgId, stepsExecuted, errors })
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    results,
  })
}
