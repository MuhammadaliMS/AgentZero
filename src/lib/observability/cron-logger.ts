/**
 * Cron Logger — Centralized observability for all cron jobs.
 *
 * Wraps any cron background function to automatically log:
 *   - Start time, duration, status (ok / error)
 *   - Output summary & error messages
 *   - Cost (if applicable)
 *   - Tokens used (if applicable)
 *
 * Writes to the `worker_executions` table for unified visibility
 * alongside chat workers and chief-loop runs.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

export interface CronRunResult {
  /** Human-readable summary of what happened */
  summary: string
  /** Optional metrics to store as JSONB */
  metrics?: Record<string, unknown>
  /** Optional cost in USD */
  costUsd?: number
  /** Optional token usage */
  tokensUsed?: Record<string, number>
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
 * await logCronRun({ worker: 'eod-wrap' }, async (log) => {
 *   // ... do work ...
 *   return { summary: 'Sent 3 EOD wraps' }
 * })
 * ```
 *
 * For per-org crons that iterate multiple orgs, use `logCronRunMultiOrg`:
 * ```ts
 * await logCronRunMultiOrg('meeting-sync', orgIds, async (orgId) => {
 *   // ... do work for this org ...
 *   return { summary: '5 meetings synced' }
 * })
 * ```
 */
export async function logCronRun(
  opts: CronLogOptions,
  fn: () => Promise<CronRunResult>
): Promise<void> {
  const supabase = createAdminClient()
  const startMs = Date.now()
  const orgId = opts.orgId ?? 'system'

  // Insert a 'running' row
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

  const executionId = row?.id

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

  // Insert top-level system row
  const { data: systemRow } = await supabase
    .from('worker_executions')
    .insert({
      worker,
      trigger: 'cron',
      org_id: orgIds[0] ?? 'system', // Use first org or system
      status: 'running',
      input_summary: `Cron triggered for ${orgIds.length} orgs`,
    })
    .select('id')
    .single()

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

  // Update system row with final summary
  if (systemRow?.id) {
    await supabase
      .from('worker_executions')
      .update({
        status: failed > 0 ? 'partial' : 'ok',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - topStartMs,
        output_summary: `Processed ${processed}/${orgIds.length} orgs (${failed} failed). ${summaries.join('; ')}`.slice(0, 2000),
      })
      .eq('id', systemRow.id)
  }

  return { processed, failed }
}
