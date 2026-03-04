/**
 * Outcome Tools — Shared tool logic for both Claude and OpenAI SDK paths.
 *
 * Three tools:
 * - create_outcome: Create a multi-step tracked task
 * - update_outcome: Update outcome/step status
 * - list_outcomes: List active outcomes
 *
 * Architecture:
 * - Handler functions (executeXxx) are exported for direct use by OpenAI path
 * - SDK tools are created via tool() from @anthropic-ai/claude-agent-sdk
 * - createOutcomeTools() returns SDK-compatible tools for createSdkMcpServer()
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  createOutcome,
  updateOutcomeStatus,
  updateStep,
  getActiveOutcomes,
  getOutcomeWithPlan,
  getOutcomesForConversation,
  type OutcomeStatus,
  type StepStatus,
} from '../runtime/outcome-runtime'
import { planOutcome } from '../planner/outcome-planner'

// ─── Types ────────────────────────────────────────────────────────────────

type ActionType = 'tool_call' | 'llm_reasoning' | 'wait_input' | 'wait_approval'

// ─── Exported Handler Functions ──────────────────────────────────────────
// Used directly by OpenAI SDK path (captain-tools.ts) and background executor.

export async function executeCreateOutcome(
  orgId: string,
  conversationId: string | undefined | null,
  input: Record<string, unknown>
): Promise<string> {
  const title = input.title as string
  const description = (input.description as string) || undefined
  const priority = (input.priority as 'critical' | 'high' | 'medium' | 'low') || 'medium'
  const rawSteps = input.steps as Array<Record<string, unknown>> | null | undefined

  // 1. Create the outcome
  const outcomeId = await createOutcome({
    orgId,
    conversationId: conversationId ?? undefined,
    title,
    description,
    priority,
    goalType: 'user_request',
  })

  if (!outcomeId) {
    return JSON.stringify({ error: 'Failed to create outcome' })
  }

  // 2. If steps provided, run the planner
  if (rawSteps && rawSteps.length > 0) {
    const planResult = await planOutcome({
      orgId,
      outcomeId,
      title,
      description: description || title,
      providedSteps: rawSteps.map((s, i) => ({
        step_order: i + 1,
        description: s.description as string,
        action_type: ((s.action_type as string) || 'tool_call') as ActionType,
        tool_name: (s.tool_name as string) || null,
        tool_args: (s.tool_args as Record<string, unknown>) || null,
        depends_on_step_orders: (s.depends_on_step_orders as number[]) || [],
        expected_output: (s.expected_output as string) || null,
        one_clear_ask: (s.one_clear_ask as string) || null,
      })),
    })

    if (!planResult.success) {
      // Mark outcome as failed
      await updateOutcomeStatus(outcomeId, 'failed', {
        orgId,
        blockerSummary: `Plan validation failed: ${planResult.errors.join(', ')}`,
      })
      return JSON.stringify({
        outcomeId,
        status: 'failed',
        errors: planResult.errors,
      })
    }

    // Move to executing
    await updateOutcomeStatus(outcomeId, 'executing', { orgId })

    return JSON.stringify({
      outcomeId,
      runId: planResult.runId,
      stepCount: planResult.stepCount,
      status: 'executing',
      planSummary: planResult.planSummary,
    })
  }

  // No steps → outcome stays in 'planning' for manual step management
  return JSON.stringify({
    outcomeId,
    status: 'planning',
    message: 'Outcome created. Add steps by updating the outcome or calling tools directly.',
  })
}

export async function executeUpdateOutcome(
  orgId: string,
  input: Record<string, unknown>
): Promise<string> {
  const outcomeId = input.outcome_id as string
  const newStatus = input.status as OutcomeStatus | null | undefined
  const blockerSummary = input.blocker_summary as string | null | undefined
  const stepUpdates = input.step_updates as Array<{
    step_id: string
    status: StepStatus
    result_summary?: string | null
    error_message?: string | null
  }> | null | undefined
  const shouldReplan = input.replan as boolean | null | undefined
  const replanReason = input.replan_reason as string | null | undefined

  // Verify outcome exists and belongs to org
  const plan = await getOutcomeWithPlan(outcomeId, orgId)
  if (!plan) {
    return JSON.stringify({ error: 'Outcome not found or access denied' })
  }

  // 1. Update step statuses
  if (stepUpdates && stepUpdates.length > 0) {
    for (const su of stepUpdates) {
      await updateStep(
        su.step_id,
        {
          status: su.status,
          resultSummary: su.result_summary ?? null,
          errorMessage: su.error_message ?? null,
        },
        orgId
      )
    }
  }

  // 2. Handle replan request
  if (shouldReplan && replanReason) {
    const { replanOutcome } = await import('../planner/outcome-planner')
    const replanResult = await replanOutcome(orgId, outcomeId, replanReason)

    if (!replanResult.success) {
      return JSON.stringify({
        outcomeId,
        replan: false,
        error: replanResult.error,
      })
    }

    return JSON.stringify({
      outcomeId,
      replan: true,
      newRunId: replanResult.runId,
      stepCount: replanResult.stepCount,
      planSummary: replanResult.planSummary,
    })
  }

  // 3. Update outcome status
  if (newStatus) {
    const statusChanged = plan.outcome.status !== newStatus
    await updateOutcomeStatus(outcomeId, newStatus, {
      orgId,
      blockerSummary: blockerSummary ?? undefined,
    })

    return JSON.stringify({
      outcomeId,
      statusChanged,
      newStatus,
      blockerSummary: blockerSummary ?? null,
    })
  }

  // 4. Just blocker update (no status change)
  if (blockerSummary !== undefined && blockerSummary !== null) {
    await updateOutcomeStatus(outcomeId, plan.outcome.status, {
      orgId,
      blockerSummary,
    })
  }

  return JSON.stringify({
    outcomeId,
    status: plan.outcome.status,
    updated: true,
  })
}

export async function executeListOutcomes(
  orgId: string,
  input: Record<string, unknown>
): Promise<string> {
  const statusFilter = input.status_filter as OutcomeStatus | null | undefined
  const limit = (input.limit as number) || 10

  let outcomes
  if (statusFilter) {
    // Filtered query
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('outcomes')
      .select('*')
      .eq('org_id', orgId)
      .eq('status', statusFilter)
      .order('created_at', { ascending: false })
      .limit(limit)

    outcomes = data?.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      title: row.title as string,
      status: row.status as string,
      priority: row.priority as string,
      blockerSummary: row.blocker_summary as string | null,
      createdAt: row.created_at as string,
    })) ?? []
  } else {
    // Active outcomes (planning, executing, blocked)
    outcomes = await getActiveOutcomes(orgId, limit)
  }

  if (outcomes.length === 0) {
    return JSON.stringify({ outcomes: [], message: 'No outcomes found' })
  }

  // Enrich with step progress for active outcomes
  const enriched = await Promise.all(
    outcomes.map(async (o: { id: string; title: string; status: string; priority: string; blockerSummary: string | null }) => {
      const plan = await getOutcomeWithPlan(o.id, orgId)
      const steps = plan?.steps ?? []
      const completed = steps.filter(s => s.status === 'completed').length
      const total = steps.length

      return {
        id: o.id,
        title: o.title,
        status: o.status,
        priority: o.priority,
        blocker: o.blockerSummary,
        progress: total > 0 ? `${completed}/${total} steps done` : 'No steps',
        blockedSteps: steps
          .filter(s => s.status === 'blocked')
          .map(s => ({ step: s.description, ask: s.oneClearAsk })),
      }
    })
  )

  return JSON.stringify({ outcomes: enriched })
}

// ─── SDK Tool Factory (for Claude SDK / createSdkMcpServer) ──────────────

export function createOutcomeTools(
  orgId: string,
  conversationId?: string | null
) {
  const createOutcomeTool = tool(
    'create_outcome',
    'Create a multi-step tracked task (outcome). Use when a user request requires 2+ tool calls that depend on each other. ' +
    'Provide a title and optionally steps. Steps will be validated and stored as a plan. ' +
    'The outcome tracks progress across conversations and executes in the background.',
    {
      title: z.string().describe('Short title for the outcome (e.g., "Prepare SOC2 board report")'),
      description: z.string().describe('Optional detailed description of the goal').optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).describe('Priority level (default: medium)').optional(),
      steps: z.array(z.object({
        description: z.string(),
        action_type: z.enum(['tool_call', 'llm_reasoning', 'wait_input', 'wait_approval']),
        tool_name: z.string().optional(),
        tool_args: z.record(z.string(), z.unknown()).optional(),
        depends_on_step_orders: z.array(z.number()).optional().default([]),
        expected_output: z.string().optional(),
        one_clear_ask: z.string().optional(),
      })).describe('Optional array of planned steps').optional(),
    },
    async (args) => {
      const result = await executeCreateOutcome(orgId, conversationId, args as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  const updateOutcomeTool = tool(
    'update_outcome',
    'Update an outcome or its steps. Use to mark steps as completed/failed, ' +
    'update outcome status (blocked, completed, failed, cancelled), or set blockers. ' +
    'If a step fails, you can trigger a replan.',
    {
      outcome_id: z.string().describe('The outcome ID to update'),
      status: z.enum(['executing', 'blocked', 'completed', 'failed', 'cancelled']).describe('New outcome status').optional(),
      blocker_summary: z.string().describe('Clear description of what is blocking progress. Include ONE specific question that will unblock.').optional(),
      step_updates: z.array(z.object({
        step_id: z.string(),
        status: z.enum(['executing', 'completed', 'failed', 'blocked', 'skipped']),
        result_summary: z.string().optional(),
        error_message: z.string().optional(),
      })).describe('Array of step updates').optional(),
      replan: z.boolean().describe('Set to true to trigger a replan (creates a new run version)').optional(),
      replan_reason: z.string().describe('Reason for replanning (required if replan=true)').optional(),
    },
    async (args) => {
      const result = await executeUpdateOutcome(orgId, args as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  const listOutcomesTool = tool(
    'list_outcomes',
    'List active and recent outcomes for the organization. ' +
    'Shows status, blockers, and step progress for each outcome. ' +
    'Use at conversation start to check ongoing tasks.',
    {
      status_filter: z.enum(['planning', 'executing', 'blocked', 'completed', 'failed', 'cancelled']).describe('Filter by status. If omitted, shows active outcomes (planning, executing, blocked).').optional(),
      limit: z.number().describe('Max outcomes to return (default: 10)').optional().default(10),
    },
    async (args) => {
      const result = await executeListOutcomes(orgId, args as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  return [createOutcomeTool, updateOutcomeTool, listOutcomesTool]
}
