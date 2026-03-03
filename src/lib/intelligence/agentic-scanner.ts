/**
 * Agentic Scanner — Tier 2 patrol scanning with LLM reasoning.
 *
 * Orchestrates the OpenAI Agents SDK patrol agent:
 * 1. Pre-flight checks (dedup, budget, integration availability)
 * 2. Gathers DB context (zero cost)
 * 3. Runs the patrol agent
 * 4. Inserts structured findings into patrol_findings
 * 5. Logs execution for cost tracking
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logWorkerExecution, completeWorkerExecution } from '@/lib/agent/hooks'
import { gatherWorkerViews } from '@/lib/intelligence/brief-synthesizer'
import { runPatrolAgent } from '@/lib/agent/openai/patrol-agent'
import type { PatrolFindings } from '@/lib/agent/openai/patrol-agent'
import type { Database } from '@/types/database'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgenticScanResult {
  findingsCreated: number
  commitmentsDiscovered: number
  memoriesStored: number
  durationMs: number
  tokensUsed: { input: number; output: number }
  skipped: boolean
  skipReason?: string
}

// Integration key → display name mapping
const INTEGRATION_KEYS: Record<string, string> = {
  gmail: 'gmail',
  microsoft: 'microsoft',
  slack: 'slack',
  google_calendar: 'google_calendar',
  vanta: 'vanta',
}

// ─── Main Scanner ────────────────────────────────────────────────────────────

export async function runAgenticScan(orgId: string, userId: string): Promise<AgenticScanResult> {
  const startTime = Date.now()
  const supabase = createAdminClient()

  // ── Pre-flight 1: Dedup — skip if agentic scan ran for this org in last 3h ──
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const { data: recentScan } = await supabase
    .from('worker_executions')
    .select('id')
    .eq('org_id', orgId)
    .eq('worker', 'patrol-analyst')
    .gte('created_at', threeHoursAgo)
    .in('status', ['running', 'completed'])
    .limit(1)
    .maybeSingle()

  if (recentScan) {
    return {
      findingsCreated: 0,
      commitmentsDiscovered: 0,
      memoriesStored: 0,
      durationMs: Date.now() - startTime,
      tokensUsed: { input: 0, output: 0 },
      skipped: true,
      skipReason: 'Agentic scan ran within last 3 hours',
    }
  }

  // ── Pre-flight 2: Check connected integrations ──────────────────────────
  const { data: orgIntegrations } = await supabase
    .from('organization_integrations')
    .select('integrations!inner(key)')
    .eq('org_id', orgId)
    .eq('is_active', true)

  const connectedIntegrations = (orgIntegrations ?? [])
    .map((oi) => {
      const integration = oi.integrations as unknown as { key: string }
      return integration?.key
    })
    .filter(Boolean) as string[]

  if (connectedIntegrations.length === 0) {
    return {
      findingsCreated: 0,
      commitmentsDiscovered: 0,
      memoriesStored: 0,
      durationMs: Date.now() - startTime,
      tokensUsed: { input: 0, output: 0 },
      skipped: true,
      skipReason: 'No external integrations connected',
    }
  }

  // ── Pre-flight 3: Daily budget — max 3 agentic scans per org per day ────
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const { count: todayCount } = await supabase
    .from('worker_executions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('worker', 'patrol-analyst')
    .gte('created_at', todayStart.toISOString())

  if ((todayCount ?? 0) >= 3) {
    return {
      findingsCreated: 0,
      commitmentsDiscovered: 0,
      memoriesStored: 0,
      durationMs: Date.now() - startTime,
      tokensUsed: { input: 0, output: 0 },
      skipped: true,
      skipReason: 'Daily scan budget exceeded (3/day)',
    }
  }

  // ── Gather DB context (zero LLM cost) ───────────────────────────────────
  const dbContext = await gatherWorkerViews(supabase, orgId)

  // ── Log execution start ─────────────────────────────────────────────────
  const executionId = await logWorkerExecution({
    org_id: orgId,
    worker: 'patrol-analyst',
    trigger: 'cron-agentic-patrol',
    input_summary: `Agentic scan — integrations: ${connectedIntegrations.join(', ')}`,
    status: 'running',
  })

  // ── Run the OpenAI patrol agent ─────────────────────────────────────────
  let agentOutput: PatrolFindings
  let tokensUsed = { input: 0, output: 0 }

  try {
    const result = await runPatrolAgent(orgId, userId, connectedIntegrations, dbContext)
    agentOutput = result.output
    tokensUsed = result.usage
  } catch (err) {
    const errorMsg = `Agent execution failed: ${(err as Error).message}`
    console.error(`[agentic-scanner] ${errorMsg}`)

    if (executionId) {
      await completeWorkerExecution(executionId, {
        status: 'failed',
        duration_ms: Date.now() - startTime,
        error: errorMsg,
      })
    }

    return {
      findingsCreated: 0,
      commitmentsDiscovered: 0,
      memoriesStored: 0,
      durationMs: Date.now() - startTime,
      tokensUsed,
      skipped: false,
      skipReason: errorMsg,
    }
  }

  // ── Process structured findings ─────────────────────────────────────────
  let findingsCreated = 0
  let commitmentsDiscovered = 0

  if (agentOutput?.findings?.length > 0) {
    for (const finding of agentOutput.findings) {
      try {
        const { error } = await supabase.from('patrol_findings').insert({
          org_id: orgId,
          type: finding.type,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          source_integrations: finding.source_integrations,
          scan_type: 'agentic' as const,
          agentic_scan_id: executionId ?? undefined,
          commitment_id: finding.commitment_id ?? undefined,
          metadata: {
            entity_name: finding.entity_name,
            scan_summary: agentOutput.summary,
          },
        })

        if (!error) {
          findingsCreated++
          if (finding.type === 'discovered_commitment') {
            commitmentsDiscovered++
          }
        } else {
          console.error(`[agentic-scanner] Failed to insert finding "${finding.title}":`, error.message)
        }
      } catch (insertErr) {
        console.error(`[agentic-scanner] Exception inserting finding:`, insertErr)
      }
    }
  }

  // ── Estimate cost ───────────────────────────────────────────────────────
  // Default model: x-ai/grok-4.1-fast via OpenRouter
  // Pricing: ~$0.20/1M input, ~$0.80/1M output (approximate)
  // Falls back to gpt-4.1-mini pricing if that model is used instead
  const costUsd =
    (tokensUsed.input * 0.0000002) + (tokensUsed.output * 0.0000008)

  // ── Log execution complete ──────────────────────────────────────────────
  const durationMs = Date.now() - startTime

  if (executionId) {
    await completeWorkerExecution(executionId, {
      output_summary: `${findingsCreated} findings, ${commitmentsDiscovered} commitments discovered. ${agentOutput.summary}`,
      status: 'completed',
      duration_ms: durationMs,
      tokens_used: tokensUsed,
      cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    })
  }

  console.log(
    `[agentic-scanner] Completed for org ${orgId}: ${findingsCreated} findings, ${commitmentsDiscovered} commitments, ${durationMs}ms, $${costUsd.toFixed(4)}`
  )

  return {
    findingsCreated,
    commitmentsDiscovered,
    memoriesStored: 0, // Agent stores memories via tool calls — counted separately
    durationMs,
    tokensUsed,
    skipped: false,
  }
}
