/**
 * Background Outcome Executor — Advances outcomes between conversations.
 *
 * This is what makes it a chief-of-staff, not a chatbot.
 * Called by cron every 5 minutes. Zero LLM cost — the planner already
 * decomposed tasks into tool calls with specific args.
 *
 * What it CAN execute (no LLM needed):
 * - tool_call steps: call the tool function directly with pre-planned args
 *
 * What it CANNOT execute (needs conversation context):
 * - llm_reasoning steps: skip, leave pending for next chat turn
 * - wait_input steps: skip, send nudge if not already sent
 * - wait_approval steps: skip, send nudge if not already sent
 *
 * SAFETY: External tools (send_email, etc.) were forced to wait_approval
 * by the plan validator — they never reach background execution.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  getOutcomeWithPlan,
  getNextExecutableSteps,
  updateStep,
  type OutcomeStep,
} from '../runtime/outcome-runtime'
import { executeNextSteps, reconcileOutcomeStatus } from './step-executor'

// ─── Types ────────────────────────────────────────────────────────────────

export interface TickResult {
  processed: number
  stepsExecuted: number
  stepsBlocked: number
  stepsSkipped: number
  headlessRuns: number
  errors: number
}

const STEP_TIMEOUT_MS = 30_000
const MAX_STEPS_PER_OUTCOME = 3
const NUDGE_COOLDOWN_HOURS = 4
const MAX_HEADLESS_PER_ORG_TICK = 3

// ─── Background Tick ──────────────────────────────────────────────────────

/**
 * Advance all executing outcomes for an org.
 * Called by cron every 5 minutes.
 */
export async function tickOutcomes(orgId: string): Promise<TickResult> {
  const supabase = createAdminClient()
  const result: TickResult = {
    processed: 0,
    stepsExecuted: 0,
    stepsBlocked: 0,
    stepsSkipped: 0,
    headlessRuns: 0,
    errors: 0,
  }

  try {
    // 1. Get all outcomes in 'executing' status for this org
    const { data: outcomes } = await supabase
      .from('outcomes')
      .select('id')
      .eq('org_id', orgId)
      .eq('status', 'executing')

    if (!outcomes || outcomes.length === 0) return result

    for (const outcome of outcomes) {
      try {
        await tickSingleOutcome(orgId, outcome.id, result)
        result.processed++
      } catch (error) {
        console.error(`[BackgroundExecutor] Error ticking outcome ${outcome.id}:`, error)
        result.errors++
      }
    }
  } catch (error) {
    console.error(`[BackgroundExecutor] Error fetching outcomes for org ${orgId}:`, error)
  }

  // 2. Process 'planning' outcomes that need headless planning
  try {
    const { data: planningOutcomes } = await supabase
      .from('outcomes')
      .select('id, title, description, related_entity_ids')
      .eq('org_id', orgId)
      .eq('status', 'planning')
      .order('created_at', { ascending: true })
      .limit(MAX_HEADLESS_PER_ORG_TICK)

    if (planningOutcomes && planningOutcomes.length > 0) {
      for (const outcome of planningOutcomes) {
        try {
          await tickPlanningOutcome(orgId, outcome, result)
        } catch (error) {
          console.error(`[BackgroundExecutor] Headless planning error for ${outcome.id}:`, error)
          result.errors++
        }
      }
    }
  } catch (error) {
    console.error(`[BackgroundExecutor] Error fetching planning outcomes for org ${orgId}:`, error)
  }

  return result
}

/**
 * Tick a single outcome — execute ready steps, nudge for blocked ones.
 */
async function tickSingleOutcome(
  orgId: string,
  outcomeId: string,
  result: TickResult
): Promise<void> {
  const plan = await getOutcomeWithPlan(outcomeId, orgId)
  if (!plan?.run || plan.run.status !== 'active') return

  const readySteps = await getNextExecutableSteps(plan.run.id)

  for (const step of readySteps) {
    // Run llm_reasoning steps via headless captain (instead of skipping)
    if (step.actionType === 'llm_reasoning') {
      try {
        const { runHeadlessCaptain } = await import('../runtime/headless-captain')

        const prompt = `You are executing step ${step.stepOrder} of an outcome plan.

Step description: ${step.description}
${step.expectedOutput ? `Expected output: ${step.expectedOutput}` : ''}

Execute this step using the appropriate tools and return the result.`

        const headlessResult = await runHeadlessCaptain(orgId, prompt, {
          maxTurns: 10,
          timeoutMs: 60_000,
        })

        if (headlessResult.error) {
          await updateStep(step.id, {
            status: 'failed',
            errorMessage: `Headless reasoning failed: ${headlessResult.error}`,
          }, orgId)
          result.errors++
        } else {
          await updateStep(step.id, {
            status: 'completed',
            resultSummary: headlessResult.text.slice(0, 2000),
          }, orgId)
          result.stepsExecuted++
          result.headlessRuns++
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[BackgroundExecutor] Headless reasoning failed for step ${step.id}:`, errMsg)
        await updateStep(step.id, {
          status: 'failed',
          errorMessage: `Headless reasoning error: ${errMsg}`,
        }, orgId)
        result.errors++
      }
      continue
    }

    if (step.actionType === 'wait_input' || step.actionType === 'wait_approval') {
      // Persist blocked status if still pending (first encounter)
      if (step.status === 'pending') {
        await updateStep(step.id, {
          status: 'blocked',
          blockerType: step.actionType === 'wait_input' ? 'input_needed' : 'approval_pending',
        }, orgId)
      }
      // Send nudge if not recently sent
      if (step.oneClearAsk || step.description) {
        await maybeNudgeForBlockedStep(orgId, outcomeId, step)
      }
      result.stepsBlocked++
      continue
    }

    // Execute tool_call steps directly
    if (step.actionType === 'tool_call' && step.toolName && step.toolArgs) {
      const execResult = await executeToolDirectly(
        orgId, step.toolName, step.toolArgs as Record<string, unknown>,
        { timeoutMs: STEP_TIMEOUT_MS }
      )

      await updateStep(step.id, {
        status: execResult.success ? 'completed' : 'failed',
        resultSummary: execResult.summary,
        errorMessage: execResult.error ?? null,
      }, orgId)

      if (execResult.success) {
        result.stepsExecuted++
      } else {
        result.errors++
      }
    }
  }

  // Reconcile outcome status after step execution
  await reconcileOutcomeStatus(orgId, outcomeId, plan.run.id)
}

// ─── Headless Planning for Draft Outcomes ─────────────────────────────────

/**
 * Run headless captain to plan a 'planning' status outcome.
 * The agent creates a plan with explicit tool_call steps.
 */
async function tickPlanningOutcome(
  orgId: string,
  outcome: { id: string; title: string; description: string | null; related_entity_ids: string[] | null },
  result: TickResult
): Promise<void> {
  const { runHeadlessCaptain, parseAgentPlan } = await import('../runtime/headless-captain')
  const { planOutcome } = await import('./outcome-planner')
  const { updateOutcomeStatus } = await import('../runtime/outcome-runtime')

  const prompt = `You are planning how to accomplish this task autonomously in the background.

Task: ${outcome.title}
${outcome.description ? `Details: ${outcome.description}` : ''}

Create a plan using the create_outcome tool with explicit steps. Each step should be a tool_call with specific tool_name and tool_args. Do NOT use llm_reasoning placeholder steps — every step must be a concrete tool call.

If this task genuinely cannot be accomplished with the available tools, explain why briefly.`

  const headlessResult = await runHeadlessCaptain(orgId, prompt, {
    maxTurns: 15,
    timeoutMs: 90_000,
  })

  result.headlessRuns++

  if (headlessResult.error) {
    console.error(`[BackgroundExecutor] Headless planning failed for ${outcome.id}: ${headlessResult.error}`)
    return // Leave as 'planning' — will retry next tick
  }

  // If the agent called create_outcome or update_outcome, the outcome
  // should now have steps (the agent tools handle this directly).
  // Check if outcome has moved past 'planning':
  const supabase = createAdminClient()
  const { data: updated } = await supabase
    .from('outcomes')
    .select('status')
    .eq('id', outcome.id)
    .single()

  if (updated?.status === 'planning') {
    // Agent didn't plan it via tools — try to parse the text response
    const steps = parseAgentPlan(headlessResult.text)

    if (steps && steps.length > 0) {
      const planResult = await planOutcome({
        orgId,
        outcomeId: outcome.id,
        title: outcome.title,
        description: outcome.description ?? '',
        providedSteps: steps,
      })
      if (planResult.success) {
        await updateOutcomeStatus(outcome.id, 'executing', { orgId })
        console.log(`[BackgroundExecutor] Headless planned outcome ${outcome.id} with ${planResult.stepCount} steps`)
      }
    } else {
      // Can't parse plan — check for NEEDS_USER_INPUT signal
      if (headlessResult.text.includes('NEEDS_USER_INPUT')) {
        const ask = headlessResult.text.split('NEEDS_USER_INPUT:')[1]?.trim()?.slice(0, 500)
        await updateOutcomeStatus(outcome.id, 'blocked', {
          orgId,
          blockerSummary: ask || 'Headless agent needs user input to plan this task',
        })
      }
      // else: leave as 'planning', will retry next tick
    }
  }
}

// ─── Headless Tool Execution ──────────────────────────────────────────────

/**
 * Execute a tool function directly without an LLM agent.
 * Uses the same shared tool logic from src/lib/agent/tools/.
 *
 * SAFETY: Only tool_call steps with pre-validated tool names reach here.
 * External tools (send_email, etc.) were already forced to wait_approval
 * by the plan validator — they never reach background execution.
 */
export async function executeToolDirectly(
  orgId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  opts: { timeoutMs: number }
): Promise<{ success: boolean; summary: string; error?: string }> {
  try {
    const result = await Promise.race([
      callToolFunction(orgId, toolName, toolArgs),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool execution timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
      ),
    ])

    return {
      success: true,
      summary: typeof result === 'string' ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000),
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[BackgroundExecutor] Tool ${toolName} failed:`, errorMsg)
    return {
      success: false,
      summary: '',
      error: errorMsg,
    }
  }
}

/**
 * Extract text from MCP tool result.
 * SDK tool handlers return { content: [{ type: 'text', text: '...' }] }.
 */
function extractTextFromMcpResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (Array.isArray(r.content) && r.content.length > 0) {
      const first = r.content[0] as Record<string, unknown>
      if (first?.type === 'text' && typeof first.text === 'string') {
        return first.text
      }
    }
  }
  return JSON.stringify(result)
}

/**
 * Call an SDK tool handler directly.
 * SDK handlers take (args, extra) and return MCP content objects.
 * We pass {} as extra and extract text from the result.
 */
async function invokeSdkTool(
  tools: Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> }>,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> {
  const tool = tools.find(t => t.name === toolName)
  if (!tool) throw new Error(`Tool ${toolName} not found`)
  const result = await tool.handler(toolArgs, {})
  return extractTextFromMcpResult(result)
}

/**
 * Map tool names to shared tool implementations.
 * This is the dispatch table for headless execution.
 */
export async function callToolFunction(
  orgId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> {
  // Dynamic imports to avoid loading all tools at startup
  switch (toolName) {
    // Memory tools
    case 'recall_memory':
    case 'store_memory':
    case 'query_entity_graph':
    case 'get_entity_timeline': {
      const { createMemoryTools } = await import('../tools/memory-tools')
      const tools = createMemoryTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Supabase tools (commitments, actions)
    case 'query_commitments':
    case 'query_actions':
    case 'create_commitment':
    case 'update_commitment':
    case 'create_action':
    case 'update_action': {
      const { createSupabaseTools } = await import('../tools/supabase-tools')
      const tools = createSupabaseTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Email tools (read-only ones safe for background)
    case 'read_recent_emails':
    case 'search_emails':
    case 'read_email': {
      const { createEmailTools } = await import('../tools/email-tools')
      const tools = createEmailTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Slack tools (read-only ones safe for background)
    case 'list_slack_channels':
    case 'read_slack_channel': {
      const { createSlackTools } = await import('../tools/slack-tools')
      const tools = createSlackTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Calendar tools
    case 'get_today_events':
    case 'get_week_events':
    case 'find_free_slots': {
      const { createCalendarTools } = await import('../tools/calendar-tools')
      const tools = createCalendarTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Vanta tools
    case 'get_compliance_overview':
    case 'list_failing_controls':
    case 'get_audit_status': {
      const { createVantaTools } = await import('../tools/vanta-tools')
      const tools = createVantaTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    // Integration tools
    case 'list_connected_integrations':
    case 'get_integration_health': {
      const { createIntegrationTools } = await import('../tools/integration-tools')
      const tools = createIntegrationTools(orgId)
      return invokeSdkTool(tools as any, toolName, toolArgs)
    }

    default:
      throw new Error(`Unknown tool for background execution: ${toolName}`)
  }
}

// ─── Nudge for Blocked Steps ──────────────────────────────────────────────

/**
 * Send a Slack nudge when a step is blocked and needs user input/approval.
 * Respects cooldown to avoid spamming.
 */
export async function maybeNudgeForBlockedStep(
  orgId: string,
  outcomeId: string,
  step: OutcomeStep
): Promise<void> {
  try {
    const supabase = createAdminClient()

    // Check for recent nudge about this outcome (within cooldown period)
    const cooldownCutoff = new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString()

    const { data: recentFindings } = await supabase
      .from('patrol_findings')
      .select('id')
      .eq('org_id', orgId)
      .eq('type', 'unresolved_blocker')
      .gte('created_at', cooldownCutoff)
      .contains('metadata', { outcome_id: outcomeId })
      .limit(1)

    if (recentFindings && recentFindings.length > 0) {
      // Already nudged recently — skip
      return
    }

    // Get outcome details for the nudge
    const plan = await getOutcomeWithPlan(outcomeId, orgId)
    if (!plan) return

    const completedSteps = plan.steps.filter(s => s.status === 'completed').length
    const totalSteps = plan.steps.length
    const askText = step.oneClearAsk ?? step.description

    // Create a patrol finding that the nudge engine will pick up
    await supabase.from('patrol_findings').insert({
      org_id: orgId,
      type: 'unresolved_blocker',
      severity: 'medium',
      title: `Outcome blocked: ${plan.outcome.title}`,
      description: `📋 "${plan.outcome.title}" is ${completedSteps}/${totalSteps} steps done but blocked — I need to know: ${askText}`,
      metadata: {
        outcome_id: outcomeId,
        step_id: step.id,
        source: 'background_executor',
      },
      status: 'open',
    })

    console.log(`[BackgroundExecutor] Nudge created for blocked outcome ${outcomeId}`)
  } catch (error) {
    // Fire-and-forget — don't fail the tick
    console.error(`[BackgroundExecutor] Error creating nudge for outcome ${outcomeId}:`, error)
  }
}
