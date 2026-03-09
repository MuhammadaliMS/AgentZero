/**
 * Cron Logger — Centralized observability for all cron jobs.
 *
 * Wraps any cron background function to automatically log:
 *   - Start time, duration, status (ok / error)
 *   - Output summary & error messages
 *   - Cost (if applicable)
 *   - Tokens used (if applicable)
 *   - Per-step agent activity (tool calls, sub-agent runs, LLM calls)
 *
 * Writes to the `worker_executions` table for unified visibility
 * alongside chat workers and chief-loop runs.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Per-Step Activity Logging ──────────────────────────────────────────

/** A single step recorded during agent execution within a cron. */
export interface ExecutionStep {
  /** ISO timestamp */
  ts: string
  /** Step type */
  type: 'tool_call' | 'tool_result' | 'sub_agent_start' | 'sub_agent_end' | 'llm_call'
  /** Tool name or sub-agent name */
  name: string
  /** Outcome status */
  status?: 'ok' | 'error'
  /** How long this step took */
  duration_ms?: number
  /** Truncated input/args summary */
  input?: string
  /** Truncated result summary */
  output?: string
  /** Error message if failed */
  error?: string
  /** Token usage for LLM steps */
  tokens?: { in: number; out: number }
}

/**
 * Collects execution steps during a cron agent run.
 * Thread-safe accumulator with a hard cap to prevent JSONB bloat.
 */
export class StepCollector {
  private steps: ExecutionStep[] = []
  private readonly maxSteps: number

  constructor(maxSteps = 200) {
    this.maxSteps = maxSteps
  }

  /** Add a raw step. */
  add(step: ExecutionStep): void {
    if (this.steps.length < this.maxSteps) {
      this.steps.push(step)
    }
  }

  /** Record a tool call start. */
  toolCall(name: string, input?: Record<string, unknown>): void {
    this.add({
      ts: new Date().toISOString(),
      type: 'tool_call',
      name,
      input: input ? JSON.stringify(input).slice(0, 200) : undefined,
    })
  }

  /** Record a tool call result. */
  toolResult(
    name: string,
    status: 'ok' | 'error',
    durationMs: number,
    output?: string,
    error?: string
  ): void {
    this.add({
      ts: new Date().toISOString(),
      type: 'tool_result',
      name,
      status,
      duration_ms: durationMs,
      output: output?.slice(0, 300),
      error: error?.slice(0, 300),
    })
  }

  /** Record a sub-agent starting. */
  subAgentStart(name: string): void {
    this.add({
      ts: new Date().toISOString(),
      type: 'sub_agent_start',
      name,
    })
  }

  /** Record a sub-agent finishing. */
  subAgentEnd(
    name: string,
    durationMs: number,
    status: 'ok' | 'error' = 'ok',
    tokens?: { in: number; out: number }
  ): void {
    this.add({
      ts: new Date().toISOString(),
      type: 'sub_agent_end',
      name,
      status,
      duration_ms: durationMs,
      tokens,
    })
  }

  /** Record a direct LLM call. */
  llmCall(
    name: string,
    durationMs: number,
    tokens?: { in: number; out: number },
    output?: string
  ): void {
    this.add({
      ts: new Date().toISOString(),
      type: 'llm_call',
      name,
      status: 'ok',
      duration_ms: durationMs,
      tokens,
      output: output?.slice(0, 300),
    })
  }

  /** Get the collected steps for storage. */
  toJSON(): ExecutionStep[] {
    return this.steps
  }

  /** Number of steps collected so far. */
  get length(): number {
    return this.steps.length
  }
}

// ─── Cron Run Result & Options ──────────────────────────────────────────

export interface CronRunResult {
  /** Human-readable summary of what happened */
  summary: string
  /** Optional metrics to store as JSONB */
  metrics?: Record<string, unknown>
  /** Optional cost in USD */
  costUsd?: number
  /** Optional token usage */
  tokensUsed?: Record<string, number>
  /** Optional per-step agent activity */
  steps?: ExecutionStep[]
}

export interface CronLogOptions {
  /** The cron worker name (e.g. 'eod-wrap', 'meeting-sync') */
  worker: string
  /** Trigger type — defaults to 'cron' */
  trigger?: string
  /** Org ID — if the cron runs per-org, pass it; otherwise defaults to 'system' */
  orgId?: string
}

/**
 * Wraps a cron background function with automatic logging to `worker_executions`.
 *
 * Usage:
 * ```ts
 * await logCronRun({ worker: 'eod-wrap' }, async () => {
 *   // ... do work ...
 *   return { summary: 'Sent 3 EOD wraps', steps: collector.toJSON() }
 * })
 * ```
 */
export async function logCronRun(
  opts: CronLogOptions,
  fn: () => Promise<CronRunResult>
): Promise<void> {
  const supabase = createAdminClient()
  const startMs = Date.now()

  // Resolve orgId: use provided, or find first onboarded org, or skip DB logging
  let orgId = opts.orgId ?? null
  if (!orgId) {
    const { data: firstOrg } = await supabase
      .from('profiles')
      .select('org_id')
      .not('onboarded_at', 'is', null)
      .limit(1)
      .single()
    orgId = firstOrg?.org_id ?? null
  }

  // Insert a 'running' row (skip if no valid org to attribute to)
  let executionId: string | undefined
  if (orgId) {
    const { data: row } = await supabase
      .from('worker_executions')
      .insert({
        worker: opts.worker,
        trigger: opts.trigger ?? 'cron',
        org_id: orgId,
        status: 'running',
        input_summary: `Cron triggered at ${new Date().toISOString()}`,
      })
      .select('id')
      .single()
    executionId = row?.id
  } else {
    console.warn(`[CronLogger] No valid org for worker=${opts.worker}, running without DB logging`)
  }

  try {
    const result = await fn()
    const durationMs = Date.now() - startMs

    if (executionId) {
      await supabase
        .from('worker_executions')
        .update({
          status: 'ok',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          output_summary: result.summary,
          cost_usd: result.costUsd ?? null,
          tokens_used: result.tokensUsed
            ? (result.tokensUsed as unknown as Json)
            : null,
          steps: result.steps?.length
            ? (result.steps as unknown as Json)
            : null,
        })
        .eq('id', executionId)
    }
  } catch (err) {
    const durationMs = Date.now() - startMs
    const errorMessage = err instanceof Error ? err.message : String(err)

    if (executionId) {
      await supabase
        .from('worker_executions')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          error: errorMessage,
        })
        .eq('id', executionId)
    }

    // Re-throw so the caller's catch block can still handle it
    throw err
  }
}

/**
 * For cron jobs that iterate over multiple orgs — logs one execution row per org.
 * Also logs a top-level "system" summary row.
 */
export async function logCronRunMultiOrg(
  worker: string,
  orgIds: string[],
  fn: (orgId: string) => Promise<CronRunResult | null>
): Promise<{ processed: number; failed: number }> {
  const supabase = createAdminClient()
  const topStartMs = Date.now()

  // Insert top-level summary row (attributed to first org, skip if no orgs)
  let systemRowId: string | undefined
  if (orgIds.length > 0) {
    const { data: systemRow } = await supabase
      .from('worker_executions')
      .insert({
        worker,
        trigger: 'cron',
        org_id: orgIds[0],
        status: 'running',
        input_summary: `Cron triggered for ${orgIds.length} orgs`,
      })
      .select('id')
      .single()
    systemRowId = systemRow?.id
  }

  let processed = 0
  let failed = 0
  const summaries: string[] = []

  for (const orgId of orgIds) {
    const startMs = Date.now()

    try {
      const result = await fn(orgId)
      const durationMs = Date.now() - startMs

      if (result) {
        // Log per-org execution
        await supabase.from('worker_executions').insert({
          worker,
          trigger: 'cron',
          org_id: orgId,
          status: 'ok',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          output_summary: result.summary,
          cost_usd: result.costUsd ?? null,
          tokens_used: result.tokensUsed
            ? (result.tokensUsed as unknown as Json)
            : null,
          steps: result.steps?.length
            ? (result.steps as unknown as Json)
            : null,
        })
        summaries.push(`${orgId.slice(0, 8)}: ${result.summary}`)
        processed++
      }
    } catch (err) {
      const durationMs = Date.now() - startMs
      const errorMessage = err instanceof Error ? err.message : String(err)

      await supabase.from('worker_executions').insert({
        worker,
        trigger: 'cron',
        org_id: orgId,
        status: 'error',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        error: errorMessage,
      })

      summaries.push(`${orgId.slice(0, 8)}: ERROR - ${errorMessage}`)
      failed++
    }
  }

  // Update summary row with final status
  if (systemRowId) {
    await supabase
      .from('worker_executions')
      .update({
        status: failed > 0 ? 'partial' : 'ok',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - topStartMs,
        output_summary: `Processed ${processed}/${orgIds.length} orgs (${failed} failed). ${summaries.join('; ')}`.slice(0, 2000),
      })
      .eq('id', systemRowId)
  }

  return { processed, failed }
}
