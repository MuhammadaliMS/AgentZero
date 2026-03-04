/**
 * Step Executor — Dual-mode execution for outcome steps.
 *
 * Two calling modes with the same core logic:
 * 1. Conversation mode — agent calls during chat (can handle llm_reasoning)
 * 2. Background mode — cron calls between conversations (skips llm_reasoning)
 *
 * Safety: 30s timeout per tool call. External tools never reach here —
 * the plan validator already forced them to wait_approval.
 */

import {
  getNextExecutableSteps,
  updateStep,
  updateOutcomeStatus,
  getOutcomeWithPlan,
  completeRun,
  type OutcomeStep,
  type StepStatus,
} from '../runtime/outcome-runtime'

// ─── Types ────────────────────────────────────────────────────────────────

export interface StepExecutionResult {
  stepId: string
  stepOrder: number
  description: string
  status: StepStatus
  resultSummary?: string
  errorMessage?: string
  /** If true, this step needs conversation context (return to agent) */
  needsAgent?: boolean
}

export type ExecutionMode = 'conversation' | 'background'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_STEPS = 3

// ─── Step Executor ────────────────────────────────────────────────────────

/**
 * Execute the next ready steps for an outcome.
 *
 * @param toolExecutor - function that executes a tool by name.
 *   In conversation mode: wraps the agent's tool calls.
 *   In background mode: calls shared tool functions directly.
 * @param opts.mode - 'conversation' or 'background'
 * @param opts.maxSteps - max steps to execute in this batch (default: 3)
 * @param opts.timeoutMs - per-step timeout in ms (default: 30000)
 */
export async function executeNextSteps(
  orgId: string,
  outcomeId: string,
  runId: string,
  toolExecutor: (toolName: string, toolArgs: Record<string, unknown>) => Promise<string>,
  opts?: {
    maxSteps?: number
    timeoutMs?: number
    mode?: ExecutionMode
  }
): Promise<StepExecutionResult[]> {
  const mode = opts?.mode ?? 'conversation'
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const results: StepExecutionResult[] = []

  // Get next executable steps (dependencies met, status=pending)
  const readySteps = await getNextExecutableSteps(runId)

  if (readySteps.length === 0) {
    return results
  }

  // Execute up to maxSteps
  const batch = readySteps.slice(0, maxSteps)

  for (const step of batch) {
    const result = await executeSingleStep(
      orgId, step, toolExecutor, mode, timeoutMs
    )
    results.push(result)
  }

  return results
}

/**
 * Execute a single step.
 */
async function executeSingleStep(
  orgId: string,
  step: OutcomeStep,
  toolExecutor: (toolName: string, toolArgs: Record<string, unknown>) => Promise<string>,
  mode: ExecutionMode,
  timeoutMs: number
): Promise<StepExecutionResult> {
  const baseResult: StepExecutionResult = {
    stepId: step.id,
    stepOrder: step.stepOrder,
    description: step.description,
    status: 'pending',
  }

  try {
    // ── wait_input / wait_approval: always block ──
    if (step.actionType === 'wait_input' || step.actionType === 'wait_approval') {
      await updateStep(step.id, {
        status: 'blocked',
        blockerType: step.actionType === 'wait_input' ? 'input_needed' : 'approval_pending',
        oneClearAsk: step.oneClearAsk ?? step.description,
      }, orgId)

      return {
        ...baseResult,
        status: 'blocked',
        needsAgent: true,
      }
    }

    // ── llm_reasoning: only in conversation mode ──
    if (step.actionType === 'llm_reasoning') {
      if (mode === 'background') {
        // Skip — leave as pending for next conversation turn
        return {
          ...baseResult,
          status: 'pending',
          needsAgent: true,
        }
      }
      // In conversation mode, return to agent for handling
      return {
        ...baseResult,
        status: 'pending',
        needsAgent: true,
      }
    }

    // ── tool_call: execute with timeout ──
    if (step.actionType === 'tool_call' && step.toolName) {
      // Mark as executing
      await updateStep(step.id, { status: 'executing' }, orgId)

      const toolArgs = step.toolArgs ?? {}

      try {
        const resultText = await executeWithTimeout(
          () => toolExecutor(step.toolName!, toolArgs),
          timeoutMs
        )

        // Success
        await updateStep(step.id, {
          status: 'completed',
          resultSummary: truncate(resultText, 2000),
        }, orgId)

        return {
          ...baseResult,
          status: 'completed',
          resultSummary: truncate(resultText, 500),
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)

        await updateStep(step.id, {
          status: 'failed',
          errorMessage: truncate(errorMsg, 1000),
        }, orgId)

        return {
          ...baseResult,
          status: 'failed',
          errorMessage: errorMsg,
        }
      }
    }

    // Unknown action type — skip
    return {
      ...baseResult,
      status: 'pending',
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[StepExecutor] Exception executing step ${step.id}:`, errorMsg)

    await updateStep(step.id, {
      status: 'failed',
      errorMessage: truncate(errorMsg, 1000),
    }, orgId).catch(() => {})

    return {
      ...baseResult,
      status: 'failed',
      errorMessage: errorMsg,
    }
  }
}

// ─── Outcome Status Reconciliation ────────────────────────────────────────

/**
 * After executing steps, reconcile the overall outcome status.
 *
 * Rules:
 * - All steps completed → outcome 'completed'
 * - Any step failed → outcome 'failed'
 * - Steps blocked (needs input/approval) → outcome 'blocked'
 * - Some pending with executable → outcome stays 'executing'
 */
export async function reconcileOutcomeStatus(
  orgId: string,
  outcomeId: string,
  runId: string
): Promise<void> {
  try {
    const plan = await getOutcomeWithPlan(outcomeId, orgId)
    if (!plan || !plan.run || plan.run.id !== runId) return

    const steps = plan.steps
    if (steps.length === 0) return

    // ── Deadlock detection: cascade 'skipped' to pending steps with dead dependencies ──
    // A step is "dead" if it failed or was skipped. If ALL dependencies of a
    // pending step are dead, that step can never execute → mark it 'skipped'.
    // Repeat until stable (handles transitive dependency chains).
    const deadStepIds = new Set(
      steps.filter(s => s.status === 'failed' || s.status === 'skipped').map(s => s.id)
    )
    let changed = true
    while (changed) {
      changed = false
      for (const step of steps) {
        if (step.status !== 'pending') continue
        const deps = step.dependsOn ?? []
        if (deps.length === 0) continue
        // If every dependency is dead, this step is dead too
        const allDepsDead = deps.every(depId => deadStepIds.has(depId))
        if (allDepsDead) {
          await updateStep(step.id, {
            status: 'skipped',
            errorMessage: 'Skipped: all dependencies failed or were skipped',
          }, orgId)
          step.status = 'skipped' // Update in-memory for cascade
          deadStepIds.add(step.id)
          changed = true
        }
      }
    }

    // ── Status counting (after cascade) ──
    const completed = steps.filter(s => s.status === 'completed').length
    const failed = steps.filter(s => s.status === 'failed').length
    const skipped = steps.filter(s => s.status === 'skipped').length
    const blocked = steps.filter(s => s.status === 'blocked').length
    const pending = steps.filter(s => s.status === 'pending').length
    const executing = steps.filter(s => s.status === 'executing').length
    const total = steps.length

    if (completed === total) {
      // All done!
      await completeRun(runId, 'completed')
      await updateOutcomeStatus(outcomeId, 'completed', { orgId })
      return
    }

    if (completed + skipped === total) {
      // All steps resolved (some skipped due to failed deps) — still "completed"
      await completeRun(runId, 'completed')
      await updateOutcomeStatus(outcomeId, 'completed', {
        orgId,
        blockerSummary: skipped > 0 ? `Completed with ${skipped} skipped step(s)` : undefined,
      })
      return
    }

    if (failed > 0 && pending === 0 && executing === 0) {
      // Failed with no more pending work (blocked steps don't count as workable)
      const failedStep = steps.find(s => s.status === 'failed')
      await completeRun(runId, 'failed')
      await updateOutcomeStatus(outcomeId, 'failed', {
        orgId,
        blockerSummary: failedStep?.errorMessage
          ? `Step failed: ${failedStep.description} — ${failedStep.errorMessage}`
          : `${failed} step(s) failed`,
      })
      return
    }

    if (blocked > 0 && pending === 0 && executing === 0) {
      // All remaining steps are blocked
      const blockedStep = steps.find(s => s.status === 'blocked')
      await updateOutcomeStatus(outcomeId, 'blocked', {
        orgId,
        blockerSummary: blockedStep?.oneClearAsk ?? `${blocked} step(s) blocked`,
      })
      return
    }

    // Some steps still pending or executing — stay in 'executing'
    if (plan.outcome.status !== 'executing') {
      await updateOutcomeStatus(outcomeId, 'executing', { orgId })
    }
  } catch (error) {
    console.error(`[StepExecutor] Error reconciling outcome ${outcomeId}:`, error)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    fn()
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}
