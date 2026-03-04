/**
 * Headless Captain — Background execution runner for the Captain agent.
 *
 * Runs the same full Captain agent (with all 33+ tools) in headless mode:
 * - No user watching — agent acts decisively
 * - Approval/integration gates auto-reject (via headlessMode flag)
 * - Strict turn budget and timeout
 * - Collects all text + tool calls and returns a structured result
 *
 * Two public functions:
 *   runHeadlessCaptain(orgId, prompt, opts?) → HeadlessCaptainResult
 *   parseAgentPlan(text) → RawPlanStep[] | null
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { StreamEvent } from '../orchestrator'
import type { RawPlanStep } from '../planner/plan-validator'

// ─── Types ────────────────────────────────────────────────────────────────

export interface HeadlessCaptainOpts {
  maxTurns?: number        // default 15
  timeoutMs?: number       // default 90_000
  conversationId?: string  // optional, for tracking
  abortSignal?: AbortSignal
}

export interface HeadlessCaptainResult {
  text: string
  toolCalls: string[]
  durationMs: number
  error?: string
}

// ─── Core Runner ──────────────────────────────────────────────────────────

/**
 * Run the Captain agent in headless (background) mode.
 *
 * 1. Resolves the primary onboarded user for the org
 * 2. Builds RunCaptainParams with headlessMode: true
 * 3. Consumes all yielded StreamEvents
 * 4. Returns collected text, tool call names, and duration
 */
export async function runHeadlessCaptain(
  orgId: string,
  prompt: string,
  opts?: HeadlessCaptainOpts
): Promise<HeadlessCaptainResult> {
  const start = Date.now()
  const maxTurns = opts?.maxTurns ?? 15
  const timeoutMs = opts?.timeoutMs ?? 90_000

  // 1. Resolve primary onboarded user for this org
  const supabase = createAdminClient()
  const { data: primaryUser } = await supabase
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .not('onboarded_at', 'is', null)
    .order('onboarded_at', { ascending: true })
    .limit(1)
    .single()

  if (!primaryUser) {
    return {
      text: '',
      toolCalls: [],
      durationMs: Date.now() - start,
      error: 'No onboarded user found for org',
    }
  }

  // 2. Build SDK params with headlessMode
  const conversationId = opts?.conversationId ?? `headless-${Date.now()}`
  const textChunks: string[] = []
  const toolCalls: string[] = []

  try {
    // Dynamic import to avoid circular dependency issues
    const { runCaptainWithSDK } = await import('../sdk-switch')
    type RunCaptainParams = Parameters<typeof runCaptainWithSDK>[0]

    const params: RunCaptainParams = {
      orgId,
      userId: primaryUser.id,
      message: prompt,
      conversationId,
      conversationHistory: [], // No history in headless mode
      headlessMode: true,
      onEmitEvent: () => {}, // Swallow SSE events in headless mode
      onToolOutput: (toolName: string) => {
        toolCalls.push(toolName)
      },
    }

    // 3. Run with timeout + turn budget
    const generator = runCaptainWithSDK(params)
    const result = await Promise.race([
      consumeGenerator(generator, textChunks, toolCalls, maxTurns),
      timeout(timeoutMs),
    ])

    if (result === 'TIMEOUT') {
      return {
        text: textChunks.join(''),
        toolCalls,
        durationMs: Date.now() - start,
        error: `Headless captain timed out after ${timeoutMs}ms`,
      }
    }

    return {
      text: textChunks.join(''),
      toolCalls,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[HeadlessCaptain] Error for org=${orgId}:`, message)
    return {
      text: textChunks.join(''),
      toolCalls,
      durationMs: Date.now() - start,
      error: message,
    }
  }
}

// ─── Generator Consumer ───────────────────────────────────────────────────

async function consumeGenerator(
  generator: AsyncGenerator<StreamEvent>,
  textChunks: string[],
  toolCalls: string[],
  maxTurns: number
): Promise<'DONE'> {
  let turnCount = 0

  for await (const event of generator) {
    switch (event.type) {
      case 'text':
        if (event.content) {
          textChunks.push(event.content)
        }
        break

      case 'tool_use':
        if (event.toolName) {
          // Deduplicate — onToolOutput also collects, but tool_use events
          // may fire even when onToolOutput doesn't (e.g., Claude SDK path)
          if (!toolCalls.includes(event.toolName)) {
            toolCalls.push(event.toolName)
          }
        }
        turnCount++
        if (turnCount >= maxTurns) {
          console.warn(`[HeadlessCaptain] Turn budget exhausted (${maxTurns} turns)`)
          return 'DONE'
        }
        break

      case 'error':
        console.error(`[HeadlessCaptain] Stream error:`, event.content)
        break

      case 'done':
        return 'DONE'
    }
  }

  return 'DONE'
}

function timeout(ms: number): Promise<'TIMEOUT'> {
  return new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms))
}

// ─── Plan Parser ──────────────────────────────────────────────────────────

/**
 * Parse structured plan steps from the agent's free-text response.
 *
 * Looks for numbered lists with tool names in square brackets or backticks:
 *   1. [search_emails] Search for recent security alerts
 *   2. `get_slack_channels` Find relevant Slack channels
 *   3. Send summary to #security channel [send_slack_dm]
 *
 * Returns null if no parseable plan is found.
 * Zero LLM cost — pure regex extraction.
 */
export function parseAgentPlan(text: string): RawPlanStep[] | null {
  if (!text || text.length < 20) return null

  const steps: RawPlanStep[] = []

  // Match numbered list items (1. 2. 3. or 1) 2) 3))
  const linePattern = /^\s*(\d+)[.)]\s+(.+)$/gm
  let match: RegExpExecArray | null

  while ((match = linePattern.exec(text)) !== null) {
    const stepOrder = parseInt(match[1], 10)
    const lineText = match[2].trim()

    // Try to extract tool name from [tool_name] or `tool_name` patterns
    const toolMatch = lineText.match(/\[([a-z_]+)\]/) || lineText.match(/`([a-z_]+)`/)
    const toolName = toolMatch ? toolMatch[1] : null

    // Remove the tool name marker from description
    let description = lineText
    if (toolMatch) {
      description = lineText.replace(toolMatch[0], '').trim()
      // Clean up leading/trailing punctuation left over
      description = description.replace(/^[:\-–—]\s*/, '').replace(/\s*[:\-–—]$/, '')
    }

    if (!description) continue

    steps.push({
      step_order: stepOrder,
      description,
      action_type: toolName ? 'tool_call' : 'llm_reasoning',
      tool_name: toolName,
      tool_args: null, // Agent doesn't provide args in free text
      depends_on_step_orders: stepOrder > 1 ? [stepOrder - 1] : [],
      expected_output: null,
      one_clear_ask: null,
    })
  }

  // Must have at least 2 steps to be considered a plan
  if (steps.length < 2) return null

  // Re-normalize step_order to be 1-indexed sequential
  steps.forEach((s, i) => {
    s.step_order = i + 1
    s.depends_on_step_orders = i > 0 ? [i] : []
  })

  return steps
}
