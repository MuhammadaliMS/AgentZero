/**
 * Outcome Planner — Constrained DAG planner for outcome execution.
 *
 * Converts an outcome into a validated run with ordered steps.
 * Supports two modes:
 * 1. Agent-provided steps: validates and stores (no LLM call)
 * 2. LLM-generated plan: calls Captain model with structured output
 *
 * Also handles replanning on failure (max 3 replans per outcome).
 */

import { createRun, addSteps, getOutcomeWithPlan, updateStep, completeRun } from '../runtime/outcome-runtime'
import { validatePlan, getAvailableToolNames, type RawPlan, type RawPlanStep } from './plan-validator'

// ─── Types ────────────────────────────────────────────────────────────────

interface PlanOutcomeParams {
  orgId: string
  outcomeId: string
  title: string
  description: string
  /** Pre-built steps from the agent (skip LLM planning) */
  providedSteps?: RawPlanStep[]
}

interface PlanResult {
  success: boolean
  runId?: string
  stepCount?: number
  planSummary?: string
  errors: string[]
}

interface ReplanResult {
  success: boolean
  runId?: string
  stepCount?: number
  planSummary?: string
  error?: string
}

const MAX_REPLANS = 3

// ─── Plan Outcome ─────────────────────────────────────────────────────────

/**
 * Create a validated plan for an outcome.
 * If providedSteps are given, validates and stores them directly (no LLM call).
 * Otherwise, would call LLM — but for v1, we require agent-provided steps.
 */
export async function planOutcome(params: PlanOutcomeParams): Promise<PlanResult> {
  const { orgId, outcomeId, title, description, providedSteps } = params

  try {
    // Determine steps to validate
    let plan: RawPlan

    if (providedSteps && providedSteps.length > 0) {
      // Agent provided steps — validate directly (no LLM call, $0 cost)
      plan = {
        plan_summary: description || title,
        steps: providedSteps,
      }
    } else {
      // No steps provided — create a minimal single-step plan
      // In v1, we rely on the agent to provide steps via the tool call.
      // Full LLM planning is a future enhancement.
      plan = {
        plan_summary: title,
        steps: [{
          step_order: 1,
          description: title,
          action_type: 'llm_reasoning',
          tool_name: null,
          tool_args: null,
          depends_on_step_orders: [],
          expected_output: 'Task completed',
          one_clear_ask: null,
        }],
      }
    }

    // Validate
    const availableTools = getAvailableToolNames()
    const validation = validatePlan(plan, availableTools)

    if (!validation.valid) {
      console.error(`[OutcomePlanner] Plan validation failed for outcome ${outcomeId}:`, validation.errors)
      return {
        success: false,
        errors: validation.errors,
      }
    }

    // Create run
    const runId = await createRun(orgId, outcomeId, {
      planSummary: plan.plan_summary,
    })

    if (!runId) {
      return {
        success: false,
        errors: ['Failed to create run'],
      }
    }

    // Build step ID mapping for dependency resolution
    // Steps reference each other by step_order. We need to convert
    // depends_on_step_orders to depends_on (UUID array) after insertion.
    const stepParams = plan.steps.map(s => ({
      runId,
      orgId,
      stepOrder: s.step_order,
      actionType: s.action_type as 'tool_call' | 'llm_reasoning' | 'wait_input' | 'wait_approval',
      description: s.description,
      toolName: s.tool_name ?? undefined,
      toolArgs: s.tool_args ?? undefined,
      expectedOutput: s.expected_output ?? undefined,
    }))

    const stepIds = await addSteps(stepParams)

    if (stepIds.length === 0) {
      return {
        success: false,
        errors: ['Failed to add steps to run'],
      }
    }

    // Resolve step_order → step_id dependencies
    // Build order→id mapping
    const orderToId = new Map<number, string>()
    for (let i = 0; i < plan.steps.length; i++) {
      orderToId.set(plan.steps[i].step_order, stepIds[i])
    }

    // Update each step's depends_on with resolved UUIDs
    for (let i = 0; i < plan.steps.length; i++) {
      const deps = plan.steps[i].depends_on_step_orders ?? []
      if (deps.length > 0) {
        const resolvedDeps = deps
          .map(order => orderToId.get(order))
          .filter(Boolean) as string[]

        if (resolvedDeps.length > 0) {
          const { createAdminClient } = await import('@/lib/supabase/admin')
          const supabase = createAdminClient()
          await supabase
            .from('outcome_steps')
            .update({ depends_on: resolvedDeps })
            .eq('id', stepIds[i])
        }
      }

      // Set one_clear_ask for wait_input steps
      if (plan.steps[i].one_clear_ask) {
        await updateStep(stepIds[i], {
          oneClearAsk: plan.steps[i].one_clear_ask,
        }, orgId)
      }
    }

    console.log(`[OutcomePlanner] Created plan for outcome ${outcomeId}: ${stepIds.length} steps`)

    return {
      success: true,
      runId,
      stepCount: stepIds.length,
      planSummary: plan.plan_summary,
      errors: [],
    }
  } catch (error) {
    console.error(`[OutcomePlanner] Exception planning outcome ${outcomeId}:`, error)
    return {
      success: false,
      errors: ['Internal error creating plan'],
    }
  }
}

// ─── Replan ───────────────────────────────────────────────────────────────

/**
 * Create a new plan version for an outcome after a failure.
 *
 * Rules:
 * 1. Latest run wins — previous active run → superseded
 * 2. Max 3 replans per outcome
 * 3. Completed steps carry forward (included in context)
 */
export async function replanOutcome(
  orgId: string,
  outcomeId: string,
  reason: string
): Promise<ReplanResult> {
  try {
    // Get current state
    const plan = await getOutcomeWithPlan(outcomeId, orgId)
    if (!plan) {
      return { success: false, error: 'Outcome not found' }
    }

    // Check replan limit
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const supabase = createAdminClient()

    const { data: runs } = await supabase
      .from('outcome_runs')
      .select('plan_version')
      .eq('outcome_id', outcomeId)
      .order('plan_version', { ascending: false })
      .limit(1)

    const currentVersion = runs?.[0]?.plan_version ?? 1
    if (currentVersion >= MAX_REPLANS) {
      // Mark outcome as failed
      const { updateOutcomeStatus } = await import('../runtime/outcome-runtime')
      await updateOutcomeStatus(outcomeId, 'failed', {
        orgId,
        blockerSummary: `Exceeded maximum replan attempts (${MAX_REPLANS})`,
      })
      return {
        success: false,
        error: `Exceeded maximum replan attempts (${MAX_REPLANS})`,
      }
    }

    // Skip completed steps in the old run — mark pending/blocked as skipped
    if (plan.run && plan.steps) {
      for (const step of plan.steps) {
        if (step.status === 'pending' || step.status === 'blocked') {
          await updateStep(step.id, { status: 'skipped' }, orgId)
        }
      }
      // Supersede the old run
      await completeRun(plan.run.id, 'failed')
    }

    // Create new run with replan context
    const completedSteps = plan.steps
      .filter(s => s.status === 'completed')
      .map(s => `- Step ${s.stepOrder}: ${s.description} → ${s.resultSummary ?? 'done'}`)
      .join('\n')

    const replanContext = completedSteps
      ? `Previous completed work:\n${completedSteps}\n\nFailure reason: ${reason}`
      : `Failure reason: ${reason}`

    const runId = await createRun(orgId, outcomeId, {
      planSummary: `Replan (v${currentVersion + 1}): ${reason}`,
      replanReason: replanContext,
    })

    if (!runId) {
      return { success: false, error: 'Failed to create replan run' }
    }

    console.log(`[OutcomePlanner] Replan created for outcome ${outcomeId}: run ${runId} (v${currentVersion + 1})`)

    return {
      success: true,
      runId,
      stepCount: 0, // Agent will add steps in the next turn
      planSummary: `Replan v${currentVersion + 1}: ${reason}`,
    }
  } catch (error) {
    console.error(`[OutcomePlanner] Exception replanning outcome ${outcomeId}:`, error)
    return { success: false, error: 'Internal error during replan' }
  }
}
