/**
 * Outcome-Centric Runtime — Phase B of Chief-of-Staff Agent V1.
 *
 * Moves from message-centric flow to outcome-based run loops.
 * Each user goal becomes an Outcome with versioned Runs and Steps.
 *
 * Key patterns:
 * - Planner: LLM creates a plan (run) with ordered steps
 * - Executor: Steps executed in dependency order
 * - Replanner: On failure or new info, LLM creates a new run version
 * - Blocked states: Steps explicitly wait with ONE clear ask
 *
 * All operations are fire-and-forget safe for the hot path.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export type OutcomeStatus =
  | 'planning'
  | 'executing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type OutcomeGoalType =
  | 'user_request'
  | 'proactive_signal'
  | 'follow_up'
  | 'scheduled'

export type StepStatus =
  | 'pending'
  | 'executing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'skipped'

export type StepActionType =
  | 'tool_call'
  | 'llm_reasoning'
  | 'wait_input'
  | 'wait_approval'
  | 'wait_dependency'
  | 'composite'

export type BlockerType =
  | 'input_needed'
  | 'approval_pending'
  | 'dependency'
  | 'tool_failure'

export type RunStatus = 'active' | 'completed' | 'superseded' | 'failed'

export interface OutcomeParams {
  orgId: string
  conversationId?: string
  title: string
  description?: string
  goalType?: OutcomeGoalType
  ownerUserId?: string
  parentOutcomeId?: string
  relatedEntityIds?: string[]
  priority?: 'critical' | 'high' | 'medium' | 'low'
}

export interface Outcome {
  id: string
  orgId: string
  conversationId: string | null
  title: string
  description: string | null
  goalType: OutcomeGoalType
  status: OutcomeStatus
  ownerUserId: string | null
  parentOutcomeId: string | null
  relatedEntityIds: string[]
  priority: string
  confidence: number | null
  blockerSummary: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface StepParams {
  runId: string
  orgId: string
  stepOrder: number
  actionType: StepActionType
  description: string
  dependsOn?: string[]
  toolName?: string
  toolArgs?: Record<string, unknown>
  expectedOutput?: string
}

export interface OutcomeStep {
  id: string
  orgId: string
  runId: string
  stepOrder: number
  dependsOn: string[]
  actionType: StepActionType
  description: string
  toolName: string | null
  toolArgs: Record<string, unknown> | null
  expectedOutput: string | null
  status: StepStatus
  blockerType: BlockerType | null
  oneClearAsk: string | null
  resultSummary: string | null
  resultData: Record<string, unknown> | null
  errorMessage: string | null
  decisionCardId: string | null
  approvalId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface OutcomeRun {
  id: string
  orgId: string
  outcomeId: string
  planVersion: number
  planSummary: string | null
  replanReason: string | null
  status: RunStatus
  decisionCardId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

// ─── Outcome CRUD ─────────────────────────────────────────────────────────

/**
 * Create a new outcome. Fire-and-forget safe.
 */
export async function createOutcome(params: OutcomeParams): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('outcomes')
      .insert({
        org_id: params.orgId,
        conversation_id: params.conversationId ?? null,
        title: params.title,
        description: params.description ?? null,
        goal_type: params.goalType ?? 'user_request',
        status: 'planning' as const,
        owner_user_id: params.ownerUserId ?? null,
        parent_outcome_id: params.parentOutcomeId ?? null,
        related_entity_ids: params.relatedEntityIds ?? [],
        priority: params.priority ?? 'medium',
      })
      .select('id')
      .single()

    if (error) {
      console.error('[OutcomeRuntime] Failed to create outcome:', error.message)
      return null
    }

    console.log(`[OutcomeRuntime] Created outcome ${data.id}: "${params.title.slice(0, 60)}"`)

    // Structured event for observability
    console.log(JSON.stringify({
      event: 'outcome_started',
      outcomeId: data.id,
      outcomeTitle: params.title,
      orgId: params.orgId,
      goalType: params.goalType ?? 'user_request',
      timestamp: new Date().toISOString(),
    }))

    return data.id
  } catch (error) {
    console.error('[OutcomeRuntime] Exception creating outcome:', error)
    return null
  }
}

/**
 * Update outcome status. Fire-and-forget safe.
 * @param orgId — Required org ownership guard to prevent cross-org mutations.
 */
export async function updateOutcomeStatus(
  outcomeId: string,
  status: OutcomeStatus,
  opts?: { blockerSummary?: string; confidence?: number; orgId?: string }
): Promise<boolean> {
  try {
    const supabase = createAdminClient()

    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'executing') {
      update.started_at = new Date().toISOString()
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      update.completed_at = new Date().toISOString()
    }
    if (opts?.blockerSummary !== undefined) {
      update.blocker_summary = opts.blockerSummary
    }
    if (opts?.confidence !== undefined) {
      update.confidence = Math.max(0, Math.min(1, opts.confidence))
    }

    let query = supabase
      .from('outcomes')
      .update(update)
      .eq('id', outcomeId)

    // Org ownership guard: prevent cross-org mutations
    if (opts?.orgId) {
      query = query.eq('org_id', opts.orgId)
    }

    const { error } = await query

    if (error) {
      console.error('[OutcomeRuntime] Failed to update outcome status:', error.message)
      return false
    }

    // Structured event for observability
    const eventType = status === 'blocked' ? 'outcome_blocked'
      : (status === 'completed' || status === 'failed' || status === 'cancelled') ? 'outcome_completed'
      : null
    if (eventType) {
      console.log(JSON.stringify({
        event: eventType,
        outcomeId,
        outcomeStatus: status,
        orgId: opts?.orgId,
        timestamp: new Date().toISOString(),
      }))
    }

    return true
  } catch (error) {
    console.error('[OutcomeRuntime] Exception updating outcome:', error)
    return false
  }
}

// ─── Run Management ───────────────────────────────────────────────────────

/**
 * Create a new run (plan version) for an outcome.
 */
export async function createRun(
  orgId: string,
  outcomeId: string,
  opts?: { planSummary?: string; replanReason?: string; decisionCardId?: string }
): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    // Get next plan version
    const { data: existing } = await supabase
      .from('outcome_runs')
      .select('plan_version')
      .eq('outcome_id', outcomeId)
      .order('plan_version', { ascending: false })
      .limit(1)

    const nextVersion = (existing?.[0]?.plan_version ?? 0) + 1

    // Supersede previous active run
    if (nextVersion > 1) {
      await supabase
        .from('outcome_runs')
        .update({ status: 'superseded' as const, completed_at: new Date().toISOString() })
        .eq('outcome_id', outcomeId)
        .eq('status', 'active')
    }

    const { data, error } = await supabase
      .from('outcome_runs')
      .insert({
        org_id: orgId,
        outcome_id: outcomeId,
        plan_version: nextVersion,
        plan_summary: opts?.planSummary ?? null,
        replan_reason: opts?.replanReason ?? null,
        status: 'active' as const,
        decision_card_id: opts?.decisionCardId ?? null,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      console.error('[OutcomeRuntime] Failed to create run:', error.message)
      return null
    }

    console.log(`[OutcomeRuntime] Created run ${data.id} (v${nextVersion}) for outcome ${outcomeId}`)
    return data.id
  } catch (error) {
    console.error('[OutcomeRuntime] Exception creating run:', error)
    return null
  }
}

/**
 * Complete a run.
 */
export async function completeRun(
  runId: string,
  status: 'completed' | 'failed'
): Promise<boolean> {
  try {
    const supabase = createAdminClient()
    const { error } = await supabase
      .from('outcome_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId)

    if (error) {
      console.error('[OutcomeRuntime] Failed to complete run:', error.message)
      return false
    }
    return true
  } catch (error) {
    console.error('[OutcomeRuntime] Exception completing run:', error)
    return false
  }
}

// ─── Step Management ──────────────────────────────────────────────────────

/**
 * Add steps to a run in bulk.
 */
export async function addSteps(steps: StepParams[]): Promise<string[]> {
  try {
    const supabase = createAdminClient()

    const rows = steps.map(s => ({
      org_id: s.orgId,
      run_id: s.runId,
      step_order: s.stepOrder,
      depends_on: s.dependsOn ?? [],
      action_type: s.actionType,
      description: s.description,
      tool_name: s.toolName ?? null,
      tool_args: (s.toolArgs ?? null) as unknown as Json,
      expected_output: s.expectedOutput ?? null,
      status: 'pending' as const,
    }))

    const { data, error } = await supabase
      .from('outcome_steps')
      .insert(rows)
      .select('id')

    if (error) {
      console.error('[OutcomeRuntime] Failed to add steps:', error.message)
      return []
    }

    return data?.map(d => d.id) ?? []
  } catch (error) {
    console.error('[OutcomeRuntime] Exception adding steps:', error)
    return []
  }
}

/**
 * Update a step's status and result.
 * @param orgId — Optional org ownership guard to prevent cross-org mutations.
 */
export async function updateStep(
  stepId: string,
  update: {
    status?: StepStatus
    blockerType?: BlockerType | null
    oneClearAsk?: string | null
    resultSummary?: string | null
    resultData?: Record<string, unknown> | null
    errorMessage?: string | null
    decisionCardId?: string | null
    approvalId?: string | null
  },
  orgId?: string
): Promise<boolean> {
  try {
    const supabase = createAdminClient()

    const row: Record<string, unknown> = {}
    if (update.status !== undefined) row.status = update.status
    if (update.blockerType !== undefined) row.blocker_type = update.blockerType
    if (update.oneClearAsk !== undefined) row.one_clear_ask = update.oneClearAsk
    if (update.resultSummary !== undefined) row.result_summary = update.resultSummary
    if (update.resultData !== undefined) row.result_data = update.resultData as unknown as Json
    if (update.errorMessage !== undefined) row.error_message = update.errorMessage
    if (update.decisionCardId !== undefined) row.decision_card_id = update.decisionCardId
    if (update.approvalId !== undefined) row.approval_id = update.approvalId

    if (update.status === 'executing') row.started_at = new Date().toISOString()
    if (update.status === 'completed' || update.status === 'failed' || update.status === 'skipped') {
      row.completed_at = new Date().toISOString()
    }

    let query = supabase
      .from('outcome_steps')
      .update(row)
      .eq('id', stepId)

    // Org ownership guard
    if (orgId) {
      query = query.eq('org_id', orgId)
    }

    const { error } = await query

    if (error) {
      console.error('[OutcomeRuntime] Failed to update step:', error.message)
      return false
    }
    return true
  } catch (error) {
    console.error('[OutcomeRuntime] Exception updating step:', error)
    return false
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────

/**
 * Get active outcomes for an org.
 */
export async function getActiveOutcomes(
  orgId: string,
  limit = 10
): Promise<Outcome[]> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .rpc('get_active_outcomes', { p_org_id: orgId, p_limit: limit })

    if (error || !data) return []
    return (data as Record<string, unknown>[]).map(mapRowToOutcome)
  } catch {
    return []
  }
}

/**
 * Get outcome with its current run and steps.
 * @param orgId — Optional org ownership guard. When provided, only returns outcome if it belongs to this org.
 */
export async function getOutcomeWithPlan(
  outcomeId: string,
  orgId?: string
): Promise<{ outcome: Outcome; run: OutcomeRun | null; steps: OutcomeStep[] } | null> {
  try {
    const supabase = createAdminClient()

    // Get outcome with org ownership guard
    let query = supabase
      .from('outcomes')
      .select('*')
      .eq('id', outcomeId)

    if (orgId) {
      query = query.eq('org_id', orgId)
    }

    const { data: outcomeRow, error: oErr } = await query.single()

    if (oErr || !outcomeRow) return null
    const outcome = mapRowToOutcome(outcomeRow as Record<string, unknown>)

    // Get active run
    const { data: runRows } = await supabase
      .from('outcome_runs')
      .select('*')
      .eq('outcome_id', outcomeId)
      .eq('status', 'active')
      .order('plan_version', { ascending: false })
      .limit(1)

    const run = runRows?.[0] ? mapRowToRun(runRows[0] as Record<string, unknown>) : null

    // Get steps for active run
    let steps: OutcomeStep[] = []
    if (run) {
      const { data: stepRows } = await supabase
        .from('outcome_steps')
        .select('*')
        .eq('run_id', run.id)
        .order('step_order', { ascending: true })

      steps = (stepRows ?? []).map(r => mapRowToStep(r as Record<string, unknown>))
    }

    return { outcome, run, steps }
  } catch {
    return null
  }
}

/**
 * Get outcomes for a conversation.
 */
export async function getOutcomesForConversation(
  orgId: string,
  conversationId: string,
  limit = 10
): Promise<Outcome[]> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('outcomes')
      .select('*')
      .eq('org_id', orgId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error || !data) return []
    return (data as Record<string, unknown>[]).map(mapRowToOutcome)
  } catch {
    return []
  }
}

/**
 * Get the next executable steps for a run (all dependencies met, status=pending).
 */
export async function getNextExecutableSteps(runId: string): Promise<OutcomeStep[]> {
  try {
    const supabase = createAdminClient()

    // Get all steps for the run
    const { data: allSteps } = await supabase
      .from('outcome_steps')
      .select('*')
      .eq('run_id', runId)
      .order('step_order', { ascending: true })

    if (!allSteps) return []

    const completedIds = new Set(
      allSteps
        .filter(s => s.status === 'completed')
        .map(s => s.id)
    )

    // Find pending steps whose dependencies are all completed
    return allSteps
      .filter(s => {
        if (s.status !== 'pending') return false
        const deps = (s.depends_on ?? []) as string[]
        return deps.every(dep => completedIds.has(dep))
      })
      .map(r => mapRowToStep(r as Record<string, unknown>))
  } catch {
    return []
  }
}

/**
 * Validate that a step belongs to an outcome (via its run).
 * Used by API routes to prevent arbitrary step mutation.
 */
export async function validateStepBelongsToOutcome(
  stepId: string,
  outcomeId: string,
  orgId: string
): Promise<boolean> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('outcome_steps')
      .select('id, run_id, org_id, outcome_runs!inner(outcome_id)')
      .eq('id', stepId)
      .eq('org_id', orgId)
      .single()

    if (error || !data) return false

    const run = data.outcome_runs as unknown as { outcome_id: string }
    return run.outcome_id === outcomeId
  } catch {
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapRowToOutcome(row: Record<string, unknown>): Outcome {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    conversationId: row.conversation_id as string | null,
    title: row.title as string,
    description: row.description as string | null,
    goalType: row.goal_type as OutcomeGoalType,
    status: row.status as OutcomeStatus,
    ownerUserId: row.owner_user_id as string | null,
    parentOutcomeId: row.parent_outcome_id as string | null,
    relatedEntityIds: (row.related_entity_ids ?? []) as string[],
    priority: row.priority as string,
    confidence: row.confidence as number | null,
    blockerSummary: row.blocker_summary as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
  }
}

function mapRowToRun(row: Record<string, unknown>): OutcomeRun {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    outcomeId: row.outcome_id as string,
    planVersion: row.plan_version as number,
    planSummary: row.plan_summary as string | null,
    replanReason: row.replan_reason as string | null,
    status: row.status as RunStatus,
    decisionCardId: row.decision_card_id as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
  }
}

function mapRowToStep(row: Record<string, unknown>): OutcomeStep {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    runId: row.run_id as string,
    stepOrder: row.step_order as number,
    dependsOn: (row.depends_on ?? []) as string[],
    actionType: row.action_type as StepActionType,
    description: row.description as string,
    toolName: row.tool_name as string | null,
    toolArgs: row.tool_args as Record<string, unknown> | null,
    expectedOutput: row.expected_output as string | null,
    status: row.status as StepStatus,
    blockerType: row.blocker_type as BlockerType | null,
    oneClearAsk: row.one_clear_ask as string | null,
    resultSummary: row.result_summary as string | null,
    resultData: row.result_data as Record<string, unknown> | null,
    errorMessage: row.error_message as string | null,
    decisionCardId: row.decision_card_id as string | null,
    approvalId: row.approval_id as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
  }
}
