/**
 * Chief Loop v2 — Unified Hourly Intelligence Runtime
 *
 * Single entrypoint: runChiefLoopForOrg(orgId, now)
 *
 * 6 Phases:
 *   A. LOCK     — Acquire org lease, skip if busy
 *   B. GATHER   — Fetch ALL raw data (zero LLM, pure SQL + integration API reads)
 *   C. THINK    — 4 sub-agents analyze data (triage → analysis → execution → graph)
 *   D. ACT      — Execute decisions (steps, graph updates, escalations)
 *   E. REFLECT  — Self-evaluate decisions, store procedural memories
 *   F. CLOSEOUT — Persist metrics, release lease, emit events
 *
 * Key design choices:
 *   - NO deterministic scoring. LLM sees all data with timestamps and decides.
 *   - NO SQL detections, confidence decay, or maintenance ops.
 *   - Graph updates happen during ACT phase via agent decisions.
 *   - Direct integration API fetches (Gmail, Slack, Calendar) in GATHER.
 *   - Model: minimax/minimax-m2.5 (configurable via CHIEF_ANALYST_MODEL).
 *   - All data includes timestamps for LLM temporal reasoning.
 *
 * Budget limits per org per hour:
 *   - Max 3 new outcomes
 *   - Max 10 step executions
 *   - Max 50 agent turns (enforced by agent runner)
 *
 * Never throws — catches per-phase errors and continues.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

// Brief synthesizer (zero-LLM org context)
import { gatherWorkerViews } from '@/lib/intelligence/brief-synthesizer'

// Outcome runtime
import {
  createOutcome,
  createRun,
  addSteps,
  updateStep,
  updateOutcomeStatus,
  getOutcomeWithPlan,
  getNextExecutableSteps,
} from '@/lib/agent/runtime/outcome-runtime'
import { reconcileOutcomeStatus } from '@/lib/agent/planner/step-executor'

// Background execution
import { executeToolDirectly } from '@/lib/agent/planner/background-executor'
import { EXTERNAL_TOOLS, validatePlan, getAvailableToolNames } from '@/lib/agent/planner/plan-validator'

// Nudge engine (blocker DM)
import { sendBlockerDM } from '@/lib/intelligence/nudge-engine'

// Worker execution logging
import { logWorkerExecution, completeWorkerExecution } from '@/lib/agent/hooks'

// Step-level observability for cron agent runs
import { StepCollector } from '@/lib/observability/cron-logger'

// Integration access
import { TokenManager } from '@/lib/integrations/token-manager'
import { WebClient } from '@slack/web-api'

// Graph update helpers
import { upsertEntities, upsertRelationship } from '@/lib/graph/extraction-pipeline'
import { runPreStoreGuard, type ResolvedRelationship } from '@/lib/graph/contradiction-detector'
import { generateEmbedding } from '@/lib/openai/client'
import type { Json } from '@/types/database'

// Chief analyst agent
import type { ChiefAnalystInput, ChiefDecision } from '@/lib/agent/openai/chief-analyst-agent'

// Risk tier engine (Feature 8)
import { computeEffectiveRisk, getRiskTier } from '@/lib/intelligence/risk-tier'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ChiefLoopResult {
  orgId: string
  leaseId: string | null
  signalsGathered: number
  replans: number
  newOutcomes: number
  stepsExecuted: number
  blockersEscalated: number
  graphUpdates: number
  deferredItems: number
  costUsd: number
  durationMs: number
  phases: Record<string, { durationMs: number; error?: string }>
  skippedReason?: string
}

// ─── Budget Constants ─────────────────────────────────────────────────────

const MAX_NEW_OUTCOMES_PER_HOUR = 3
const MAX_STEP_EXECUTIONS_PER_HOUR = 10
const REPLAN_COOLDOWN_MS = 4 * 60 * 60 * 1000 // 4 hours
const LEASE_DURATION_MINUTES = 55
const AGENT_TIMEOUT_MS = 180_000 // 3 minutes

// ─── Working Memory Types (Feature 5) ───────────────────────────────────

interface AttentionItem {
  id: string
  type: 'outcome' | 'signal' | 'entity' | 'blocker'
  description: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  addedAt: string
  ttlHours: number
}

interface Prediction {
  id: string
  prediction: string
  confidence: number
  deadline: string
  decisionType: string
  targetId?: string
  createdAt: string
}

interface DeferredItem {
  id: string
  signalType: string
  signalId: string
  reason: string
  deferUntil: string
  createdAt: string
}

interface DecisionLogEntry {
  type: string
  rationaleAbbrev: string
  targetId?: string
  createdAt: string
}

export interface WorkingMemory {
  runningSummary: string
  attentionItems: AttentionItem[]
  predictions: Prediction[]
  deferredItems: DeferredItem[]
  decisionLog: DecisionLogEntry[]
  accuracyStats: Record<string, { avg: number; count: number; trend: 'improving' | 'stable' | 'declining' }>
  version: number
}

// ─── Main Entry ───────────────────────────────────────────────────────────

export async function runChiefLoopForOrg(
  orgId: string,
  now: Date = new Date()
): Promise<ChiefLoopResult> {
  const startTime = Date.now()
  const supabase = createAdminClient()

  const result: ChiefLoopResult = {
    orgId,
    leaseId: null,
    signalsGathered: 0,
    replans: 0,
    newOutcomes: 0,
    stepsExecuted: 0,
    blockersEscalated: 0,
    graphUpdates: 0,
    deferredItems: 0,
    costUsd: 0,
    durationMs: 0,
    phases: {},
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase A: LOCK — Acquire org lease
  // ═══════════════════════════════════════════════════════════════════════
  let leaseId: string | null = null
  try {
    const phaseStart = Date.now()
    leaseId = await acquireLease(supabase, orgId, now)
    result.phases.lock = { durationMs: Date.now() - phaseStart }

    if (!leaseId) {
      result.skippedReason = 'lease_busy'
      result.durationMs = Date.now() - startTime
      return result
    }
    result.leaseId = leaseId
  } catch (error) {
    result.phases.lock = { durationMs: 0, error: (error as Error).message }
    result.skippedReason = 'lease_error'
    result.durationMs = Date.now() - startTime
    return result
  }

  // Log worker execution
  const executionId = await logWorkerExecution({
    org_id: orgId,
    worker: 'chief-loop',
    trigger: 'cron',
    input_summary: 'Hourly chief loop v2',
    status: 'running',
  })

  // Step-level activity collector for agent observability
  const stepCollector = new StepCollector()

  // Hoist for carry-forward generation in closeout and reflect phase
  let gatherResult: GatherResult | null = null
  let thinkDecisions: ChiefDecision[] = []
  let previousCarryForward: string | null = null

  try {
    // ═════════════════════════════════════════════════════════════════════
    // Phase B: GATHER — Fetch ALL raw data (zero LLM)
    // ═════════════════════════════════════════════════════════════════════
    gatherResult = await phaseGather(supabase, orgId, now)
    result.phases.gather = { durationMs: gatherResult.durationMs }
    if (gatherResult.error) result.phases.gather.error = gatherResult.error
    result.signalsGathered = gatherResult.totalSignals

    // Feature 5: Derive previousCarryForward from working memory (backward compat)
    previousCarryForward = gatherResult.workingMemory?.runningSummary ?? null
    if (!previousCarryForward) {
      // Fallback: fetch from lease table for orgs that don't have working memory yet
      previousCarryForward = await fetchPreviousCarryForward(supabase, orgId).catch(e => {
        console.error('[ChiefLoop] carry-forward fetch error:', e)
        return null
      })
    }

    // ═════════════════════════════════════════════════════════════════════
    // Phase C: THINK — LLM agent analyzes everything
    // ═════════════════════════════════════════════════════════════════════
    const thinkResult = await phaseThink(supabase, orgId, now, gatherResult, previousCarryForward, stepCollector)
    result.phases.think = { durationMs: thinkResult.durationMs }
    if (thinkResult.error) result.phases.think.error = thinkResult.error
    result.costUsd += thinkResult.costUsd
    thinkDecisions = thinkResult.decisions

    // ═════════════════════════════════════════════════════════════════════
    // Phase D: ACT — Execute decisions + steps + graph + escalation
    // ═════════════════════════════════════════════════════════════════════
    const actResult = await phaseAct(supabase, orgId, leaseId, thinkResult.decisions)
    result.phases.act = { durationMs: actResult.durationMs }
    if (actResult.error) result.phases.act.error = actResult.error
    result.replans = actResult.replans
    result.newOutcomes = actResult.newOutcomes
    result.stepsExecuted = actResult.stepsExecuted
    result.blockersEscalated = actResult.blockersEscalated
    result.graphUpdates = actResult.graphUpdates
    result.deferredItems = actResult.deferred

    // ═════════════════════════════════════════════════════════════════════
    // Phase E: REFLECT — Self-evaluate decisions, store procedural memories
    // ═════════════════════════════════════════════════════════════════════
    if (thinkDecisions.length > 0 && gatherResult) {
      const reflectResult = await phaseReflect(
        supabase, orgId, thinkDecisions, gatherResult, previousCarryForward, stepCollector
      ).catch(e => {
        console.error('[ChiefLoop] reflect error:', e)
        return { durationMs: 0, memoriesStored: 0, error: (e as Error).message } as ReflectResult
      })
      result.phases.reflect = { durationMs: reflectResult.durationMs }
      if (reflectResult.error) result.phases.reflect.error = reflectResult.error
    }

  } catch (error) {
    console.error(`[ChiefLoop] Unhandled error for org ${orgId}:`, error)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase F: CLOSEOUT — Persist metrics, release lease
  // ═══════════════════════════════════════════════════════════════════════
  const closeoutStart = Date.now()
  result.durationMs = closeoutStart - startTime

  // Feature 5: Build and persist structured working memory
  let carryForward: string | null = null
  if (gatherResult) {
    try {
      const workingMemory = buildWorkingMemory(result, thinkDecisions, gatherResult)
      await upsertWorkingMemory(supabase, orgId, workingMemory)
      // Derive carry_forward TEXT for lease audit trail (backward compat)
      carryForward = workingMemory.runningSummary.slice(0, 2000)
    } catch (error) {
      console.error('[ChiefLoop] working memory build/persist error:', error)
      // Fallback: build legacy carry-forward
      try {
        carryForward = buildCarryForward(result, thinkDecisions, gatherResult)
      } catch (fallbackErr) {
        console.error('[ChiefLoop] carry-forward fallback error:', fallbackErr)
      }
    }
  }

  // Release lease (with carry-forward)
  try {
    await releaseLease(supabase, leaseId, result, carryForward)
  } catch (error) {
    console.error(`[ChiefLoop] Lease release failed for org ${orgId} (will TTL-expire):`, error)
  }

  // Log events
  try {
    await logChiefLoopEvent(supabase, orgId, leaseId, 'chief_loop_completed', {
      metadata: {
        signalsGathered: result.signalsGathered,
        replans: result.replans,
        newOutcomes: result.newOutcomes,
        stepsExecuted: result.stepsExecuted,
        blockersEscalated: result.blockersEscalated,
        graphUpdates: result.graphUpdates,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      },
    })
  } catch (error) {
    console.error(`[ChiefLoop] Event log failed for org ${orgId}:`, error)
  }

  // Complete worker execution — surface phase errors for observability
  try {
    if (executionId) {
      // Collect all phase errors for visibility
      const phaseErrors = Object.entries(result.phases)
        .filter(([, v]) => v.error)
        .map(([k, v]) => `${k}: ${v.error}`)
      const hasErrors = phaseErrors.length > 0
      const phaseTiming = Object.entries(result.phases)
        .map(([k, v]) => `${k}=${v.durationMs}ms`)
        .join(' ')

      console.log(`[ChiefLoop] org=${orgId}: stepCollector has ${stepCollector.length} agent activity steps, phases: ${phaseTiming}${hasErrors ? `, ERRORS: ${phaseErrors.join('; ')}` : ''}`)
      await completeWorkerExecution(executionId, {
        status: hasErrors ? 'failed' : 'completed',
        output_summary: `signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} outcome_steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} deferred=${result.deferredItems} agent_steps=${stepCollector.length} phases=[${phaseTiming}]`,
        duration_ms: result.durationMs,
        cost_usd: result.costUsd,
        steps: stepCollector.length > 0 ? stepCollector.toJSON() : undefined,
        error: hasErrors ? phaseErrors.join('; ') : undefined,
      })
    }
  } catch (error) {
    console.error(`[ChiefLoop] Worker execution completion failed for org ${orgId}:`, error)
  }

  result.phases.closeout = { durationMs: Date.now() - closeoutStart }
  result.durationMs = Date.now() - startTime

  console.log(
    `[ChiefLoop] org=${orgId}: signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} outcome_steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} agent_steps=${stepCollector.length} cost=$${result.costUsd.toFixed(4)} (${result.durationMs}ms)`
  )

  return result
}

// ─── Phase A: Lease Acquisition ──────────────────────────────────────────

async function acquireLease(
  supabase: SupabaseClient,
  orgId: string,
  _now: Date
): Promise<string | null> {
  // Hour-bucket dedup: skip if already completed this clock hour
  const hourStart = new Date(_now)
  hourStart.setMinutes(0, 0, 0)
  const { data: recentCompleted } = await supabase
    .from('chief_loop_leases')
    .select('id')
    .eq('org_id', orgId)
    .eq('status', 'completed')
    .gte('acquired_at', hourStart.toISOString())
    .limit(1)

  if (recentCompleted && recentCompleted.length > 0) {
    console.log(`[ChiefLoop] Skipping org ${orgId} — already completed this hour (lease ${(recentCompleted[0] as { id: string }).id})`)
    return null
  }

  // Atomic lease acquisition via RPC
  const { data: leaseId, error } = await supabase.rpc('try_acquire_chief_lease', {
    p_org_id: orgId,
    p_ttl_minutes: LEASE_DURATION_MINUTES,
  })

  if (error) {
    console.error(`[ChiefLoop] Lease RPC error for org ${orgId}:`, error.message)
    return null
  }

  if (!leaseId) {
    console.log(`[ChiefLoop] Skipping org ${orgId} — active lease held by another run`)
    return null
  }

  return leaseId as string
}

async function releaseLease(
  supabase: SupabaseClient,
  leaseId: string,
  result: ChiefLoopResult,
  carryForward?: string | null
): Promise<void> {
  const { error } = await supabase.rpc('release_chief_lease', {
    p_lease_id: leaseId,
    p_status: 'completed',
    p_result_summary: `signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} steps=${result.stepsExecuted} graph=${result.graphUpdates}`,
    p_signals_ingested: result.signalsGathered,
    p_outcomes_created: result.newOutcomes,
    p_steps_executed: result.stepsExecuted,
    p_cost_usd: result.costUsd,
    p_carry_forward: carryForward ?? null,
  })

  if (error) {
    console.error(`[ChiefLoop] Lease release RPC error for ${leaseId}:`, error.message)
  }
}

// ─── Phase B: Gather ─────────────────────────────────────────────────────
// Pure data fetching. No LLM. No scoring. No maintenance.
// Fetches from DB tables AND directly from integration APIs.

interface GatherResult {
  durationMs: number
  totalSignals: number
  error?: string

  // All raw data with timestamps
  orgName: string
  activeOutcomes: ChiefAnalystInput['activeOutcomes']
  recentEmails: ChiefAnalystInput['recentEmails']
  recentSlackMessages: ChiefAnalystInput['recentSlackMessages']
  todayEvents: ChiefAnalystInput['todayEvents']
  recentInsights: ChiefAnalystInput['recentInsights']
  recentFindings: ChiefAnalystInput['recentFindings']
  topEntities: ChiefAnalystInput['topEntities']
  recentRelationships: ChiefAnalystInput['recentRelationships']
  recentMemories: ChiefAnalystInput['recentMemories']
  workerViews: Awaited<ReturnType<typeof gatherWorkerViews>> | null
  connectedIntegrations: string[]
  proceduralMemories: Array<{ id: string; triggerPattern: string; successfulApproach: string; successRate: number }>
  workingMemory: WorkingMemory | null
  // Feature 7: Decision accuracy stats (last 30 days)
  decisionAccuracy: Record<string, { avg: number; count: number }> | null
}

async function phaseGather(
  supabase: SupabaseClient,
  orgId: string,
  now: Date
): Promise<GatherResult> {
  const startTime = Date.now()

  const r: GatherResult = {
    durationMs: 0,
    totalSignals: 0,
    orgName: 'Unknown',
    activeOutcomes: [],
    recentEmails: [],
    recentSlackMessages: [],
    todayEvents: [],
    recentInsights: [],
    recentFindings: [],
    topEntities: [],
    recentRelationships: [],
    recentMemories: [],
    workerViews: null,
    connectedIntegrations: [],
    proceduralMemories: [],
    workingMemory: null,
    decisionAccuracy: null,
  }

  try {
    // All fetches in parallel — independent data sources
    const [
      orgData,
      outcomes,
      insights,
      findings,
      entities,
      relationships,
      memories,
      workerViews,
      integrations,
      emails,
      slackMessages,
      calendarEvents,
      proceduralMems,
      workingMem,
      accuracyStats,
      _evalCount,
    ] = await Promise.all([
      // Org name
      supabase.from('organizations').select('name').eq('id', orgId).single()
        .then(r => r.data as { name: string } | null),

      // Active outcomes with runs + steps
      fetchActiveOutcomes(supabase, orgId),

      // Recent insights (no age filter — LLM judges freshness via timestamps)
      supabase
        .from('graph_insights')
        .select('id, insight_type, category, summary, confidence, severity, created_at, updated_at')
        .eq('org_id', orgId)
        .in('status', ['active', 'routed'])
        .order('created_at', { ascending: false })
        .limit(30)
        .then(r => r.data ?? []),

      // Open findings
      supabase
        .from('patrol_findings')
        .select('id, type, severity, title, description, status, created_at')
        .eq('org_id', orgId)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(20)
        .then(r => r.data ?? []),

      // Top entities by mention count
      supabase
        .from('entities')
        .select('id, name, entity_type, mention_count, last_seen_at, created_at, description')
        .eq('org_id', orgId)
        .order('mention_count', { ascending: false })
        .limit(30)
        .then(r => r.data ?? []),

      // Recent relationships
      supabase
        .from('entity_relationships')
        .select(`
          id, relationship_type, confidence, created_at, updated_at,
          source:entities!source_entity_id(name),
          target:entities!target_entity_id(name)
        `)
        .eq('org_id', orgId)
        .is('valid_to', null)
        .order('updated_at', { ascending: false })
        .limit(20)
        .then(r => r.data ?? []),

      // Recent memories
      supabase
        .from('memory')
        .select('id, category, subject, content, confidence, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(20)
        .then(r => r.data ?? []),

      // Worker views (zero LLM)
      gatherWorkerViews(supabase as any, orgId).catch(e => {
        console.error(`[ChiefLoop:gather] worker views error for org=${orgId}:`, e instanceof Error ? e.message : e, e instanceof Error ? e.stack : '')
        return null
      }),

      // Connected integrations
      supabase
        .from('organization_integrations')
        .select('integration_id')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .then(r => (r.data ?? []).map(i => (i as { integration_id: string }).integration_id)),

      // Direct Gmail API fetch
      fetchRecentEmails(orgId).catch(e => {
        console.error('[ChiefLoop:gather] email fetch error:', e)
        return [] as GatherResult['recentEmails']
      }),

      // Direct Slack API fetch
      fetchRecentSlackMessages(orgId).catch(e => {
        console.error('[ChiefLoop:gather] Slack fetch error:', e)
        return [] as GatherResult['recentSlackMessages']
      }),

      // Direct Calendar API fetch
      fetchTodayCalendarEvents(orgId, now).catch(e => {
        console.error('[ChiefLoop:gather] calendar fetch error:', e)
        return [] as GatherResult['todayEvents']
      }),

      // Procedural memory (proven approaches from past runs)
      fetchProceduralMemories(supabase, orgId).catch(e => {
        console.error('[ChiefLoop:gather] procedural memory fetch error:', e)
        return [] as GatherResult['proceduralMemories']
      }),

      // Working memory (Feature 5 — structured inter-run state)
      fetchWorkingMemory(supabase, orgId).catch(e => {
        console.error('[ChiefLoop:gather] working memory fetch error:', e)
        return null as WorkingMemory | null
      }),

      // Feature 7: Decision accuracy stats (last 30 days)
      fetchAccuracyStats(supabase, orgId).catch(e => {
        console.error('[ChiefLoop:gather] accuracy stats fetch error:', e)
        return null as Record<string, { avg: number; count: number }> | null
      }),

      // Feature 7: Auto-evaluate mature pending decisions
      evaluatePendingDecisions(supabase, orgId).catch(e => {
        console.error('[ChiefLoop:gather] decision evaluation error:', e)
        return 0
      }),
    ])

    r.orgName = orgData?.name ?? 'Unknown'
    r.activeOutcomes = outcomes
    r.recentEmails = emails
    r.recentSlackMessages = slackMessages
    r.todayEvents = calendarEvents
    r.workerViews = workerViews
    r.connectedIntegrations = integrations
    r.proceduralMemories = proceduralMems
    r.workingMemory = workingMem
    r.decisionAccuracy = accuracyStats

    // Map DB rows to typed arrays
    r.recentInsights = (insights as any[]).map(i => ({
      id: i.id,
      insightType: i.insight_type,
      category: i.category,
      summary: i.summary,
      confidence: i.confidence,
      severity: i.severity,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    }))

    r.recentFindings = (findings as any[]).map(f => ({
      id: f.id,
      type: f.type,
      severity: f.severity,
      title: f.title,
      description: f.description ?? f.title,
      status: f.status,
      createdAt: f.created_at,
    }))

    r.topEntities = (entities as any[]).map(e => ({
      id: e.id,
      name: e.name,
      entityType: e.entity_type,
      mentionCount: e.mention_count ?? 0,
      lastSeenAt: e.last_seen_at ?? e.created_at,
      createdAt: e.created_at,
      description: e.description,
    }))

    r.recentRelationships = (relationships as any[]).map(rel => ({
      id: rel.id,
      sourceEntityName: rel.source?.name ?? 'unknown',
      targetEntityName: rel.target?.name ?? 'unknown',
      relationshipType: rel.relationship_type,
      confidence: rel.confidence ?? 1.0,
      createdAt: rel.created_at,
      updatedAt: rel.updated_at,
    }))

    r.recentMemories = (memories as any[]).map(m => ({
      id: m.id,
      category: m.category,
      subject: m.subject,
      content: m.content,
      confidence: m.confidence ?? 0.8,
      createdAt: m.created_at,
    }))

    r.totalSignals = r.recentEmails.length + r.recentSlackMessages.length +
      r.recentInsights.length + r.recentFindings.length + r.todayEvents.length

  } catch (error) {
    console.error('[ChiefLoop:gather] Error:', error)
    r.error = (error as Error).message
  }

  r.durationMs = Date.now() - startTime
  return r
}

// ─── Procedural Memory (Feature 11) ──────────────────────────────────────
// Fetch proven approach patterns from past runs. Agents use these to make
// better decisions based on historical success/failure data.

/** Fetch top procedural memories (proven approaches) for this org */
async function fetchProceduralMemories(
  supabase: SupabaseClient,
  orgId: string,
  limit: number = 10
): Promise<GatherResult['proceduralMemories']> {
  const { data } = await supabase
    .from('procedural_memory')
    .select('id, trigger_pattern, successful_approach, success_count, failure_count')
    .eq('org_id', orgId)
    .order('success_count', { ascending: false })
    .limit(limit)

  return (data ?? []).map((m: any) => ({
    id: m.id,
    triggerPattern: m.trigger_pattern,
    successfulApproach: m.successful_approach,
    successRate: m.success_count / Math.max(1, m.success_count + m.failure_count),
  }))
}

// ─── Carry-Forward Context (QW1) ─────────────────────────────────────────
// Template-based summary of what happened in the last run, persisted in the
// chief_loop_leases table. No LLM call — pure string interpolation.

/** Fetch the carry_forward text from the most recent completed lease for this org */
async function fetchPreviousCarryForward(
  supabase: SupabaseClient,
  orgId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('chief_loop_leases')
    .select('carry_forward')
    .eq('org_id', orgId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)

  const row = data?.[0] as { carry_forward: string | null } | undefined
  return row?.carry_forward ?? null
}

/** Build a carry-forward summary from this run's results (no LLM) */
function buildCarryForward(
  result: ChiefLoopResult,
  thinkDecisions: ChiefDecision[],
  gatherResult: GatherResult
): string {
  const lines: string[] = []

  // Key metrics
  lines.push(`Last run: signals=${result.signalsGathered} outcomes=${result.newOutcomes} replans=${result.replans} steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} deferred=${result.deferredItems}`)

  // Active outcomes summary
  if (gatherResult.activeOutcomes.length > 0) {
    lines.push(`Active outcomes (${gatherResult.activeOutcomes.length}):`)
    for (const o of gatherResult.activeOutcomes.slice(0, 5)) {
      const completed = o.steps.filter(s => s.status === 'completed').length
      const blocked = o.steps.filter(s => s.status === 'blocked').length
      lines.push(`  - "${o.title}" [${o.priority}]: ${completed}/${o.steps.length} done${blocked > 0 ? `, ${blocked} blocked` : ''}`)
    }
    if (gatherResult.activeOutcomes.length > 5) {
      lines.push(`  ... and ${gatherResult.activeOutcomes.length - 5} more`)
    }
  }

  // Newly created outcomes this run
  const newOutcomeDecisions = thinkDecisions.filter(d => d.type === 'create_outcome')
  if (newOutcomeDecisions.length > 0) {
    lines.push(`Created this run:`)
    for (const d of newOutcomeDecisions) {
      lines.push(`  + "${(d.payload as { title?: string }).title ?? 'unknown'}"`)
    }
  }

  // Escalated blockers
  const escalations = thinkDecisions.filter(d => d.type === 'escalate_blocker')
  if (escalations.length > 0) {
    lines.push(`Escalated blockers:`)
    for (const e of escalations) {
      lines.push(`  ! ${(e.payload as { oneClearAsk?: string }).oneClearAsk ?? e.rationale}`)
    }
  }

  // Deferred items
  const deferred = thinkDecisions.filter(d => d.type === 'defer')
  if (deferred.length > 0) {
    lines.push(`Deferred (revisit next cycle):`)
    for (const d of deferred) {
      lines.push(`  ~ ${(d.payload as { candidateId?: string }).candidateId}: ${d.rationale.slice(0, 100)}`)
    }
  }

  // Key insights stored
  const insights = thinkDecisions.filter(d => d.type === 'store_insight')
  if (insights.length > 0) {
    lines.push(`Insights stored: ${insights.length}`)
    for (const i of insights.slice(0, 3)) {
      lines.push(`  * ${i.rationale.slice(0, 100)}`)
    }
  }

  // Cap at 2000 chars to avoid bloating the prompt
  const text = lines.join('\n')
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text
}

// ─── Working Memory (Feature 5) ──────────────────────────────────────────
// Structured JSON working memory per org. Replaces carry-forward TEXT with
// rich state: attention items, predictions, deferred items, decision log.

/** Fetch structured working memory for this org (one row per org) */
async function fetchWorkingMemory(
  supabase: SupabaseClient,
  orgId: string
): Promise<WorkingMemory | null> {
  const { data } = await supabase
    .from('working_memory')
    .select('running_summary, attention_items, predictions, deferred_items, decision_log, accuracy_stats, version')
    .eq('org_id', orgId)
    .single()

  if (!data) return null

  const row = data as any
  return {
    runningSummary: row.running_summary ?? '',
    attentionItems: (row.attention_items ?? []) as AttentionItem[],
    predictions: (row.predictions ?? []) as Prediction[],
    deferredItems: (row.deferred_items ?? []) as DeferredItem[],
    decisionLog: (row.decision_log ?? []) as DecisionLogEntry[],
    accuracyStats: (row.accuracy_stats ?? {}) as WorkingMemory['accuracyStats'],
    version: row.version ?? 1,
  }
}

/** Build structured working memory from this run's results (no LLM) */
function buildWorkingMemory(
  result: ChiefLoopResult,
  decisions: ChiefDecision[],
  gatherResult: GatherResult
): WorkingMemory {
  const now = new Date().toISOString()
  const previousMemory = gatherResult.workingMemory

  // ── Running summary (same logic as buildCarryForward but richer) ──
  const summaryLines: string[] = []
  summaryLines.push(`Run at ${now}: signals=${result.signalsGathered} outcomes=${result.newOutcomes} replans=${result.replans} steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} deferred=${result.deferredItems}`)

  if (gatherResult.activeOutcomes.length > 0) {
    summaryLines.push(`Active outcomes (${gatherResult.activeOutcomes.length}):`)
    for (const o of gatherResult.activeOutcomes.slice(0, 5)) {
      const completed = o.steps.filter(s => s.status === 'completed').length
      const blocked = o.steps.filter(s => s.status === 'blocked').length
      summaryLines.push(`  - "${o.title}" [${o.priority}]: ${completed}/${o.steps.length} done${blocked > 0 ? `, ${blocked} blocked` : ''}`)
    }
    if (gatherResult.activeOutcomes.length > 5) {
      summaryLines.push(`  ... and ${gatherResult.activeOutcomes.length - 5} more`)
    }
  }

  const newOutcomeDecisions = decisions.filter(d => d.type === 'create_outcome')
  if (newOutcomeDecisions.length > 0) {
    summaryLines.push(`Created this run:`)
    for (const d of newOutcomeDecisions) {
      summaryLines.push(`  + "${(d.payload as { title?: string }).title ?? 'unknown'}"`)
    }
  }

  const escalations = decisions.filter(d => d.type === 'escalate_blocker')
  if (escalations.length > 0) {
    summaryLines.push(`Escalated blockers:`)
    for (const e of escalations) {
      summaryLines.push(`  ! ${(e.payload as { oneClearAsk?: string }).oneClearAsk ?? e.rationale}`)
    }
  }

  const runningSummary = summaryLines.join('\n').slice(0, 3000)

  // ── Attention items: outcomes with blockers + carry forward unexpired ──
  const attentionItems: AttentionItem[] = gatherResult.activeOutcomes
    .filter(o => o.steps.some(s => s.status === 'blocked'))
    .map(o => ({
      id: o.id,
      type: 'outcome' as const,
      description: `"${o.title}" has ${o.steps.filter(s => s.status === 'blocked').length} blocked steps`,
      priority: o.priority as AttentionItem['priority'],
      addedAt: now,
      ttlHours: 24,
    }))

  // Carry forward unexpired attention items from previous memory
  if (previousMemory) {
    const cutoff = Date.now()
    for (const item of previousMemory.attentionItems) {
      const expiresAt = new Date(item.addedAt).getTime() + item.ttlHours * 3600_000
      if (expiresAt > cutoff && !attentionItems.some(a => a.id === item.id)) {
        attentionItems.push(item)
      }
    }
  }

  // ── Predictions: carry forward unexpired predictions ──
  const predictions: Prediction[] = (previousMemory?.predictions ?? [])
    .filter(p => new Date(p.deadline).getTime() > Date.now())

  // ── Deferred items from defer decisions ──
  const deferredItems: DeferredItem[] = decisions
    .filter(d => d.type === 'defer')
    .map(d => ({
      id: crypto.randomUUID(),
      signalType: 'unknown',
      signalId: (d.payload as { candidateId?: string }).candidateId ?? '',
      reason: d.rationale.slice(0, 200),
      deferUntil: new Date(Date.now() + 3600_000).toISOString(), // revisit next hour
      createdAt: now,
    }))

  // ── Decision log: this run + carry forward (keep last 20) ──
  const decisionLog: DecisionLogEntry[] = [
    ...decisions.map(d => ({
      type: d.type,
      rationaleAbbrev: d.rationale.slice(0, 100),
      targetId: (d.payload as { outcomeId?: string; stepId?: string }).outcomeId
        ?? (d.payload as { stepId?: string }).stepId,
      createdAt: now,
    })),
    ...(previousMemory?.decisionLog ?? []),
  ].slice(0, 20)

  // ── Accuracy stats: merge fresh DB stats with trend from previous memory ──
  const accuracyStats: WorkingMemory['accuracyStats'] = {}
  const freshStats = gatherResult.decisionAccuracy
  const prevStats = previousMemory?.accuracyStats ?? {}

  if (freshStats && Object.keys(freshStats).length > 0) {
    for (const [type, stats] of Object.entries(freshStats)) {
      const prev = prevStats[type]
      let trend: 'improving' | 'stable' | 'declining' = 'stable'
      if (prev) {
        const delta = stats.avg - prev.avg
        if (delta > 0.05) trend = 'improving'
        else if (delta < -0.05) trend = 'declining'
      }
      accuracyStats[type] = { avg: stats.avg, count: stats.count, trend }
    }
    // Carry forward types that exist in previous memory but have no recent decisions
    for (const [type, prev] of Object.entries(prevStats)) {
      if (!accuracyStats[type]) {
        accuracyStats[type] = prev // keep stale data with its existing trend
      }
    }
  } else {
    // No fresh stats — carry forward previous memory's accuracy stats as-is
    Object.assign(accuracyStats, prevStats)
  }

  return {
    runningSummary,
    attentionItems: attentionItems.slice(0, 20),
    predictions: predictions.slice(0, 15),
    deferredItems: deferredItems.slice(0, 10),
    decisionLog,
    accuracyStats,
    version: (previousMemory?.version ?? 0) + 1,
  }
}

/** Upsert working memory for this org (one row per org) */
async function upsertWorkingMemory(
  supabase: SupabaseClient,
  orgId: string,
  memory: WorkingMemory
): Promise<void> {
  const { error } = await supabase
    .from('working_memory')
    .upsert({
      org_id: orgId,
      running_summary: memory.runningSummary,
      attention_items: memory.attentionItems as unknown as Json,
      predictions: memory.predictions as unknown as Json,
      deferred_items: memory.deferredItems as unknown as Json,
      decision_log: memory.decisionLog as unknown as Json,
      accuracy_stats: memory.accuracyStats as unknown as Json,
    }, { onConflict: 'org_id' })

  if (error) console.error('[ChiefLoop] Working memory upsert error:', error.message)
}

// ─── Integration Data Fetchers ───────────────────────────────────────────

async function fetchRecentEmails(orgId: string): Promise<GatherResult['recentEmails']> {
  const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
  if (!gmailTokens) return []

  try {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=newer_than:1d`,
      { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
    )
    const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
    if (listData.error || !listData.messages?.length) return []

    const emails = await Promise.all(
      listData.messages.slice(0, 15).map(async (msg) => {
        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
        )
        const detail = (await detailRes.json()) as {
          id: string; snippet: string
          payload?: { headers?: Array<{ name: string; value: string }> }
        }
        const headers = detail.payload?.headers ?? []
        const getH = (n: string) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
        return { id: detail.id, subject: getH('Subject'), from: getH('From'), date: getH('Date'), snippet: detail.snippet }
      })
    )
    return emails
  } catch (e) {
    console.error('[ChiefLoop:gather] Gmail fetch error:', (e as Error).message)
    return []
  }
}

async function fetchRecentSlackMessages(orgId: string): Promise<GatherResult['recentSlackMessages']> {
  const tokens = await TokenManager.getTokens(orgId, 'slack')
  if (!tokens) return []

  const client = new WebClient(tokens.user_access_token || tokens.access_token)
  try {
    const searchRes = await client.search.messages({
      query: `to:me after:${Math.floor((Date.now() - 24 * 3600_000) / 1000)}`,
      count: 20, sort: 'timestamp', sort_dir: 'desc',
    })
    return (searchRes.messages?.matches ?? []).slice(0, 15).map(m => ({
      channel: m.channel?.name ?? 'unknown',
      from: m.username ?? 'unknown',
      text: m.text?.substring(0, 300) ?? '',
      ts: m.ts ?? '',
      permalink: m.permalink,
    }))
  } catch (e) {
    console.error('[ChiefLoop:gather] Slack fetch error:', (e as Error).message)
    return []
  }
}

async function fetchTodayCalendarEvents(orgId: string, now: Date): Promise<GatherResult['todayEvents']> {
  const googleTokens = await TokenManager.getTokens(orgId, 'google_calendar')
  if (!googleTokens) return []

  try {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(end.getDate() + 2)

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=30`,
      { headers: { Authorization: `Bearer ${googleTokens.access_token}` } }
    )
    const data = (await res.json()) as { items?: Array<Record<string, unknown>>; error?: { message: string } }
    if (data.error) return []

    return (data.items ?? []).map(e => ({
      summary: (e.summary as string) ?? 'No title',
      start: String((e.start as Record<string, unknown>)?.dateTime || (e.start as Record<string, unknown>)?.date || ''),
      end: String((e.end as Record<string, unknown>)?.dateTime || (e.end as Record<string, unknown>)?.date || ''),
    }))
  } catch (e) {
    console.error('[ChiefLoop:gather] Calendar fetch error:', (e as Error).message)
    return []
  }
}

async function fetchActiveOutcomes(supabase: SupabaseClient, orgId: string): Promise<GatherResult['activeOutcomes']> {
  const { data: outcomes } = await supabase
    .from('outcomes')
    .select('id, title, description, status, priority, created_at, updated_at')
    .eq('org_id', orgId)
    .in('status', ['planning', 'executing', 'blocked'])
    .limit(20)

  if (!outcomes || outcomes.length === 0) return []

  const result: GatherResult['activeOutcomes'] = []

  for (const o of outcomes) {
    const outcome = o as { id: string; title: string; description: string | null; status: string; priority: string; created_at: string; updated_at: string }

    // Get active run
    const { data: runs } = await supabase
      .from('outcome_runs')
      .select('id')
      .eq('outcome_id', outcome.id)
      .eq('status', 'active')
      .limit(1)

    const runId = runs?.[0] ? (runs[0] as { id: string }).id : null
    let steps: GatherResult['activeOutcomes'][0]['steps'] = []

    if (runId) {
      const { data: stepRows } = await supabase
        .from('outcome_steps')
        .select('id, step_order, description, status, action_type, tool_name, one_clear_ask, created_at, updated_at')
        .eq('run_id', runId)
        .order('step_order')

      steps = (stepRows ?? []).map((s: any) => ({
        id: s.id,
        stepOrder: s.step_order,
        description: s.description,
        status: s.status,
        actionType: s.action_type,
        toolName: s.tool_name,
        oneClearAsk: s.one_clear_ask,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }))
    }

    result.push({
      ...outcome,
      createdAt: outcome.created_at,
      updatedAt: outcome.updated_at,
      runId,
      steps,
    })
  }

  return result
}

// ─── Phase C: Think ──────────────────────────────────────────────────────
// Single LLM agent call with ALL gathered data.
// The agent uses READ tools to dig deeper and DECISION tools to express actions.

interface ThinkResult {
  durationMs: number
  decisions: ChiefDecision[]
  costUsd: number
  error?: string
}

async function phaseThink(
  supabase: SupabaseClient,
  orgId: string,
  now: Date,
  gather: GatherResult,
  previousCarryForward?: string | null,
  collector?: StepCollector
): Promise<ThinkResult> {
  const startTime = Date.now()
  const r: ThinkResult = { durationMs: 0, decisions: [], costUsd: 0 }

  // Provide empty defaults if worker views failed (don't skip Think entirely)
  const emptyWorkerViews: import('@/lib/intelligence/brief-synthesizer').WorkerViews = {
    cole: { activeCount: 0, atRiskCount: 0, overdueCount: 0, completedTodayCount: 0, topDeadlines: [], pendingActionsCount: 0, oldestActionDays: null },
    rhea: { hasVantaConnection: false, failingControlsCount: 0, topFailingControls: [], complianceFindings: 0 },
    eve: { recentDecisions: [], keyStakeholders: [] },
    patrol: { openFindingsCount: 0, criticalFindings: 0, byType: {}, newSinceYesterday: 0 },
    insights: { contradictions: [], patterns: [], anomalies: [], staleItems: [], risks: [], totalActive: 0 },
    outcomes: { active: [], totalActive: 0 },
  }

  if (!gather.workerViews) {
    console.warn(`[ChiefLoop:think] org=${orgId}: workerViews is null — using empty defaults. Agent will still run with emails/Slack/calendar data.`)
  }

  try {
    // Detect timezone from calendar events or default to UTC
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

    const input: ChiefAnalystInput = {
      orgId,
      orgName: gather.orgName,
      currentTime: now.toISOString(),
      timezone,
      activeOutcomes: gather.activeOutcomes,
      recentEmails: gather.recentEmails,
      recentSlackMessages: gather.recentSlackMessages,
      todayEvents: gather.todayEvents,
      recentInsights: gather.recentInsights,
      recentFindings: gather.recentFindings,
      topEntities: gather.topEntities,
      recentRelationships: gather.recentRelationships,
      recentMemories: gather.recentMemories,
      workerViews: gather.workerViews ?? emptyWorkerViews,
      connectedIntegrations: gather.connectedIntegrations,

      // QW1: Carry-forward context from previous run
      previousCarryForward: previousCarryForward ?? undefined,

      // Feature 11: Procedural memories (proven approaches)
      proceduralMemories: gather.proceduralMemories,

      // Feature 5: Structured working memory from previous runs
      workingMemory: gather.workingMemory ?? undefined,

      // Feature 7: Decision accuracy stats
      decisionAccuracy: gather.decisionAccuracy ?? undefined,
    }

    // Feature 10: Try sub-agents first, fall back to monolithic on error
    let agentResult: { decisions: ChiefDecision[]; usage: { input: number; output: number }; turns: number; durationMs: number }

    try {
      const { runSubAgents } = await import('@/lib/agent/openai/chief-sub-agents')
      agentResult = await Promise.race([
        runSubAgents(input, collector),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Sub-agents timed out after ${AGENT_TIMEOUT_MS / 1000}s`)), AGENT_TIMEOUT_MS)
        ),
      ])
      console.log(`[ChiefLoop:think] Sub-agents completed: ${agentResult.decisions.length} decisions, ${agentResult.turns} turns, ${agentResult.durationMs}ms`)
    } catch (subAgentError) {
      console.warn('[ChiefLoop:think] Sub-agent error, falling back to monolithic:', (subAgentError as Error).message)

      // Fallback: original monolithic runChiefAnalyst — zero regression risk
      const { runChiefAnalyst } = await import('@/lib/agent/openai/chief-analyst-agent')
      agentResult = await Promise.race([
        runChiefAnalyst(input, collector),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Chief analyst timed out after ${AGENT_TIMEOUT_MS / 1000}s`)), AGENT_TIMEOUT_MS)
        ),
      ])
      console.log(`[ChiefLoop:think] Monolithic fallback completed: ${agentResult.decisions.length} decisions, ${agentResult.turns} turns, ${agentResult.durationMs}ms`)
    }

    r.decisions = agentResult.decisions
    r.costUsd = estimateCost(agentResult.usage.input, agentResult.usage.output)
  } catch (error) {
    console.error('[ChiefLoop:think] Agent error:', error)
    r.error = (error as Error).message
  }

  r.durationMs = Date.now() - startTime
  return r
}

// ─── Phase D: Act ────────────────────────────────────────────────────────
// Process all agent decisions, execute ready steps, update graph, escalate blockers.

interface ActResult {
  durationMs: number
  replans: number
  newOutcomes: number
  stepsExecuted: number
  blockersEscalated: number
  graphUpdates: number
  deferred: number
  errors: number
  error?: string
  // Feature 8: Risk tier tracking
  approvalsPending: number
  notificationsQueued: number
}

async function phaseAct(
  supabase: SupabaseClient,
  orgId: string,
  leaseId: string,
  decisions: ChiefDecision[]
): Promise<ActResult> {
  const startTime = Date.now()
  const r: ActResult = {
    durationMs: 0, replans: 0, newOutcomes: 0, stepsExecuted: 0,
    blockersEscalated: 0, graphUpdates: 0, deferred: 0, errors: 0,
    approvalsPending: 0, notificationsQueued: 0,
  }

  // ── Per-decision-type rate limits ──
  const MAX_GRAPH_UPDATES_PER_HOUR = 30
  const MAX_INSIGHTS_PER_HOUR = 15
  const MAX_MEMORIES_PER_HOUR = 15
  const MAX_REPLANS_PER_HOUR = 3
  const MAX_ESCALATIONS_PER_HOUR = 5
  let insightsCreated = 0
  let memoriesCreated = 0

  // Feature 8: Collect notifications to batch-send after all decisions
  const pendingNotifications: Array<{
    decisionType: string; decisionSummary: string; riskScore: number
    targetType?: string; targetId?: string
  }> = []

  // ── Process agent decisions ──
  for (const decision of decisions) {
    try {
      // ── Feature 8: Risk Tier Gate ──
      // Compute effective risk score (with safety floors for external tools)
      const stepToolName = (decision.payload as Record<string, unknown>).toolName as string | undefined
      const stepRiskClass = (decision.payload as Record<string, unknown>).riskClass as string | undefined
      const effectiveRisk = computeEffectiveRisk(decision, { stepToolName, stepRiskClass })
      const riskTier = getRiskTier(effectiveRisk)

      if (riskTier === 'approval') {
        // APPROVAL tier → block execution, create pending approval
        try {
          await supabase.from('pending_approvals').insert({
            approval_id: crypto.randomUUID(),
            conversation_id: `chief_loop:${leaseId}`,
            org_id: orgId,
            tool_name: decision.type,
            tool_input: decision.payload as Json,
            status: 'pending',
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30-min timeout
            risk_score: effectiveRisk,
            source: 'chief_loop',
            decision_type: decision.type,
            decision_rationale: decision.rationale.slice(0, 500),
          })
          await logChiefLoopEvent(supabase, orgId, leaseId, 'decision_blocked_by_risk', {
            rationale: decision.rationale,
            policyResult: 'blocked_by_risk_tier',
            policyReason: `Risk score ${effectiveRisk.toFixed(2)} → approval tier (>0.7). Awaiting user approval.`,
            metadata: { riskScore: effectiveRisk, riskTier, decisionType: decision.type },
          })
          r.approvalsPending++
          r.deferred++
          console.log(`[ChiefLoop:act] Risk tier APPROVAL for ${decision.type} (score=${effectiveRisk.toFixed(2)}) — blocked pending approval`)
        } catch (err) {
          console.error('[ChiefLoop:act] Failed to create risk-tier approval:', err)
          r.errors++
        }
        continue // Skip execution — awaiting approval
      }

      if (riskTier === 'notify') {
        // NOTIFY tier → execute normally, then queue notification
        pendingNotifications.push({
          decisionType: decision.type,
          decisionSummary: decision.rationale.slice(0, 300),
          riskScore: effectiveRisk,
          targetType: (decision.payload as Record<string, unknown>).outcomeId ? 'outcome' : undefined,
          targetId: ((decision.payload as Record<string, unknown>).outcomeId ?? (decision.payload as Record<string, unknown>).stepId ?? (decision.payload as Record<string, unknown>).entityId) as string | undefined,
        })
      }
      // AUTO tier → execute normally, no notification

      switch (decision.type) {
        case 'attach_signal': {
          const p = decision.payload as {
            outcomeId: string; signalType: string; signalId: string; linkType: string
          }
          await supabase.from('outcome_signal_links').upsert({
            org_id: orgId,
            outcome_id: p.outcomeId,
            signal_type: p.signalType,
            signal_id: p.signalId,
            link_type: p.linkType,
            linked_by: 'chief_loop',
          }, { onConflict: 'outcome_id,signal_type,signal_id' })
          await logChiefLoopEvent(supabase, orgId, leaseId, 'signal_attached_to_outcome', {
            targetType: 'outcome', targetId: p.outcomeId,
            rationale: decision.rationale, policyResult: 'allowed',
          })
          break
        }

        case 'branch_replan': {
          if (r.replans >= MAX_REPLANS_PER_HOUR) {
            await logChiefLoopEvent(supabase, orgId, leaseId, 'budget_deferred', {
              rationale: decision.rationale, policyResult: 'deferred',
              policyReason: `Replan rate limit: ${r.replans}/${MAX_REPLANS_PER_HOUR}`,
            })
            r.deferred++
            continue
          }
          const p = decision.payload as {
            outcomeId: string; reason: string; materialChanges: string[]
            newSteps: Array<{
              step_order: number; action_type: string; description: string
              tool_name?: string; tool_args?: Record<string, unknown>; risk_class: string
            }>
            removedStepIds: string[]
          }

          // Policy gate: replan cooldown
          const { data: recentRuns } = await supabase
            .from('outcome_runs')
            .select('created_at')
            .eq('outcome_id', p.outcomeId)
            .order('created_at', { ascending: false })
            .limit(1)

          if (recentRuns?.[0]) {
            const lastRunAge = Date.now() - new Date((recentRuns[0] as { created_at: string }).created_at).getTime()
            if (lastRunAge < REPLAN_COOLDOWN_MS) {
              await logChiefLoopEvent(supabase, orgId, leaseId, 'outcome_replanned', {
                targetType: 'outcome', targetId: p.outcomeId,
                rationale: decision.rationale,
                policyResult: 'blocked_by_policy',
                policyReason: `Replan cooldown: last run ${Math.round(lastRunAge / 60000)}min ago (min: ${REPLAN_COOLDOWN_MS / 60000}min)`,
              })
              r.deferred++
              continue
            }
          }

          // Policy gate: must have material changes
          if (!p.materialChanges || p.materialChanges.length === 0) {
            await logChiefLoopEvent(supabase, orgId, leaseId, 'outcome_replanned', {
              targetType: 'outcome', targetId: p.outcomeId,
              rationale: decision.rationale,
              policyResult: 'blocked_by_policy',
              policyReason: 'No material_changes provided',
            })
            continue
          }

          // Get current plan
          const plan = await getOutcomeWithPlan(p.outcomeId, orgId)
          if (!plan?.run) continue

          // Supersede current run
          await supabase
            .from('outcome_runs')
            .update({ status: 'superseded', completed_at: new Date().toISOString() })
            .eq('id', plan.run.id)

          // Create new run
          const newRunId = await createRun(orgId, p.outcomeId, {
            planSummary: `Replanned by chief loop: ${p.materialChanges.join('; ')}`,
            replanReason: p.reason,
          })

          if (newRunId) {
            const removedSet = new Set(p.removedStepIds ?? [])

            // Carry forward completed steps (immutable evidence)
            const completedSteps = plan.steps.filter(s => s.status === 'completed')
            const pendingKeptSteps = plan.steps.filter(
              s => s.status === 'pending' && !removedSet.has(s.id)
            )
            const carriedCount = completedSteps.length + pendingKeptSteps.length

            const stepsToAdd = [
              ...completedSteps.map((s, i) => ({
                runId: newRunId, orgId, stepOrder: i + 1,
                actionType: s.actionType as any, description: s.description,
                toolName: s.toolName ?? undefined,
                toolArgs: (s.toolArgs ?? undefined) as Record<string, unknown> | undefined,
                riskClass: ((s as any).riskClass ?? 'internal') as 'internal' | 'external',
              })),
              ...pendingKeptSteps.map((s, i) => {
                const isExternalTool = s.toolName && EXTERNAL_TOOLS.includes(s.toolName)
                return {
                  runId: newRunId, orgId, stepOrder: completedSteps.length + i + 1,
                  actionType: s.actionType as any, description: s.description,
                  toolName: s.toolName ?? undefined,
                  toolArgs: (s.toolArgs ?? undefined) as Record<string, unknown> | undefined,
                  riskClass: (isExternalTool ? 'external' : ((s as any).riskClass ?? 'internal')) as 'internal' | 'external',
                }
              }),
              ...p.newSteps.map((s, i) => {
                const isExternalTool = s.tool_name && EXTERNAL_TOOLS.includes(s.tool_name)
                const effectiveRiskClass = isExternalTool ? 'external' : (s.risk_class ?? 'internal')
                const effectiveActionType = isExternalTool ? 'wait_approval' : s.action_type
                return {
                  runId: newRunId, orgId, stepOrder: carriedCount + i + 1,
                  actionType: effectiveActionType as any, description: s.description,
                  toolName: s.tool_name, toolArgs: s.tool_args,
                  riskClass: effectiveRiskClass as 'internal' | 'external',
                  dependsOn: carriedCount > 0 && i === 0 ? [] : undefined,
                }
              }),
            ]

            if (stepsToAdd.length > 0) {
              await addSteps(stepsToAdd)

              // Mark carried completed steps as completed
              const { data: newStepRows } = await supabase
                .from('outcome_steps')
                .select('id, step_order')
                .eq('run_id', newRunId)
                .lte('step_order', completedSteps.length)
              if (newStepRows) {
                for (const ns of newStepRows) {
                  await updateStep((ns as { id: string }).id, { status: 'completed' }, orgId)
                }
              }
            }

            // Block external steps
            const { data: externalSteps } = await supabase
              .from('outcome_steps')
              .select('id')
              .eq('run_id', newRunId)
              .eq('risk_class', 'external')
              .eq('status', 'pending')
            if (externalSteps) {
              for (const es of externalSteps) {
                await updateStep(
                  (es as { id: string }).id,
                  { status: 'blocked', blockerType: 'approval_pending' },
                  orgId
                )
              }
            }

            await updateOutcomeStatus(p.outcomeId, 'executing', { orgId })
          }

          await logChiefLoopEvent(supabase, orgId, leaseId, 'outcome_replanned', {
            targetType: 'outcome', targetId: p.outcomeId,
            rationale: decision.rationale, policyResult: 'allowed',
            metadata: { materialChanges: p.materialChanges, newRunId },
          })
          r.replans++
          break
        }

        case 'create_outcome': {
          if (r.newOutcomes >= MAX_NEW_OUTCOMES_PER_HOUR) {
            await logChiefLoopEvent(supabase, orgId, leaseId, 'budget_deferred', {
              rationale: decision.rationale,
              policyResult: 'deferred',
              policyReason: `Budget exhausted: ${r.newOutcomes}/${MAX_NEW_OUTCOMES_PER_HOUR} outcomes this hour`,
            })
            r.deferred++
            continue
          }

          const p = decision.payload as {
            title: string; description: string; priority: string
            relatedEntityIds: string[]
            steps: Array<{
              step_order: number; action_type: string; description: string
              tool_name?: string; tool_args?: Record<string, unknown>
              expected_output?: string; risk_class: string
            }>
          }

          // ── Pre-validate plan before creating outcome ──
          const planForValidation = {
            plan_summary: `Auto-created by chief loop: ${p.title}`,
            steps: p.steps.map(s => ({
              step_order: s.step_order,
              description: s.description,
              action_type: s.action_type as 'tool_call' | 'llm_reasoning' | 'wait_input' | 'wait_approval',
              tool_name: s.tool_name ?? null,
              tool_args: s.tool_args ?? null,
              depends_on_step_orders: [] as number[],
              expected_output: s.expected_output ?? null,
              one_clear_ask: null,
            })),
          }
          const validation = validatePlan(planForValidation, getAvailableToolNames())
          if (!validation.valid) {
            await logChiefLoopEvent(supabase, orgId, leaseId, 'plan_validation_failed', {
              rationale: decision.rationale,
              policyResult: 'rejected',
              policyReason: `Plan validation failed: ${validation.errors.join(', ')}`,
              metadata: { title: p.title, errors: validation.errors },
            })
            r.deferred++
            continue
          }

          const hasExternal = p.steps.some(s => s.risk_class === 'external')

          const outcomeId = await createOutcome({
            orgId, title: p.title, description: p.description,
            goalType: 'proactive_signal',
            priority: p.priority as any,
            relatedEntityIds: p.relatedEntityIds,
          })

          if (outcomeId) {
            const runId = await createRun(orgId, outcomeId, {
              planSummary: `Auto-created by chief loop: ${p.title}`,
            })

            if (runId) {
              const stepsToAdd = p.steps.map(s => {
                const isExternalTool = s.tool_name && EXTERNAL_TOOLS.includes(s.tool_name)
                const effectiveRiskClass = isExternalTool ? 'external' : (s.risk_class ?? 'internal')
                const effectiveActionType = isExternalTool ? 'wait_approval' : s.action_type
                return {
                  runId, orgId, stepOrder: s.step_order,
                  actionType: effectiveActionType as any,
                  description: s.description,
                  toolName: s.tool_name, toolArgs: s.tool_args,
                  expectedOutput: s.expected_output,
                  riskClass: effectiveRiskClass as 'internal' | 'external',
                }
              })
              const stepIds = await addSteps(stepsToAdd)

              if (stepIds.length > 0) {
                const { data: extSteps } = await supabase
                  .from('outcome_steps')
                  .select('id')
                  .eq('run_id', runId)
                  .eq('risk_class', 'external')
                  .eq('status', 'pending')
                if (extSteps) {
                  for (const es of extSteps) {
                    await updateStep(
                      (es as { id: string }).id,
                      { status: 'blocked', blockerType: 'approval_pending' },
                      orgId
                    )
                  }
                }
              }

              await supabase
                .from('outcome_runs')
                .update({ trigger_source: 'chief_loop' })
                .eq('id', runId)
            }

            await updateOutcomeStatus(
              outcomeId,
              hasExternal ? 'planning' : 'executing',
              { orgId }
            )

            await logChiefLoopEvent(supabase, orgId, leaseId, 'outcome_auto_created', {
              targetType: 'outcome', targetId: outcomeId,
              rationale: decision.rationale, policyResult: 'allowed',
              metadata: { hasExternal, stepCount: p.steps.length },
            })
            r.newOutcomes++
          }
          break
        }

        case 'execute_step': {
          const p = decision.payload as { stepId: string }
          await logChiefLoopEvent(supabase, orgId, leaseId, 'step_executed', {
            targetType: 'step', targetId: p.stepId,
            rationale: decision.rationale, policyResult: 'allowed',
          })
          // Actual execution happens below in step execution loop
          break
        }

        case 'skip_step': {
          const p = decision.payload as { stepId: string }
          await updateStep(p.stepId, {
            status: 'skipped',
            errorMessage: `Skipped by chief loop: ${decision.rationale}`,
          }, orgId)
          await logChiefLoopEvent(supabase, orgId, leaseId, 'step_executed', {
            targetType: 'step', targetId: p.stepId,
            rationale: decision.rationale, policyResult: 'allowed',
            metadata: { action: 'skip' },
          })
          break
        }

        case 'block_step': {
          const p = decision.payload as { stepId: string; oneClearAsk: string }
          await updateStep(p.stepId, {
            status: 'blocked',
            blockerType: 'input_needed',
            oneClearAsk: p.oneClearAsk,
          }, orgId)
          await logChiefLoopEvent(supabase, orgId, leaseId, 'step_blocked', {
            targetType: 'step', targetId: p.stepId,
            rationale: decision.rationale, policyResult: 'allowed',
          })
          break
        }

        case 'store_insight': {
          if (insightsCreated >= MAX_INSIGHTS_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            type: string; summary: string; confidence: number
            severity?: string
            related_entity_ids?: string[]; action_template?: Record<string, unknown>
          }
          await supabase.rpc('upsert_insight_with_dedupe', {
            p_org_id: orgId,
            p_idempotency_key: `chief_loop:${p.type}:${p.summary.slice(0, 100).replace(/\s+/g, '_').toLowerCase()}`,
            p_insight_type: p.type,
            p_category: 'chief_loop_discovery',
            p_summary: p.summary,
            p_confidence: p.confidence,
            p_entity_ids: p.related_entity_ids ?? [],
            p_evidence: { source: 'chief_loop', rationale: decision.rationale },
            p_action_template: p.action_template ?? null,
          })
          insightsCreated++
          break
        }

        case 'store_memory': {
          if (memoriesCreated >= MAX_MEMORIES_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            category: string; subject: string; content: string; entities?: string[]
          }
          await supabase.from('memory').insert({
            org_id: orgId,
            category: p.category,
            subject: p.subject,
            content: p.content,
            source: 'chief-loop',
            confidence: 0.8,
            related_entities: p.entities ?? [],
          })
          memoriesCreated++
          break
        }

        // ── Graph Update Decisions (NEW) ──

        case 'create_entity': {
          if (r.graphUpdates >= MAX_GRAPH_UPDATES_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            name: string; entityType: string; description?: string
            attributes: Record<string, unknown>
          }
          try {
            const entityIdMap = await upsertEntities(supabase as any, orgId, [{
              name: p.name,
              type: p.entityType as any,
              description: p.description,
              attributes: p.attributes,
            }])

            // Generate embedding for the new entity
            const entityId = entityIdMap.values().next().value
            if (entityId) {
              const embeddingText = `${p.name}: ${p.description || p.entityType}`
              const embedding = await generateEmbedding(embeddingText)
              if (embedding) {
                await supabase
                  .from('entities')
                  .update({ embedding: JSON.stringify(embedding) })
                  .eq('id', entityId)
              }
              r.graphUpdates++
            }
          } catch (err) {
            console.error('[ChiefLoop:act] create_entity error:', err)
            r.errors++
          }
          break
        }

        case 'create_relationship': {
          if (r.graphUpdates >= MAX_GRAPH_UPDATES_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            sourceEntityId: string; targetEntityId: string
            relationshipType: string; properties: Record<string, unknown>
            confidence: number
          }
          try {
            // Run pre-store guard for contradiction detection
            const resolved: ResolvedRelationship[] = [{
              sourceId: p.sourceEntityId,
              targetId: p.targetEntityId,
              source: p.sourceEntityId, // Will be resolved by guard
              target: p.targetEntityId,
              type: p.relationshipType,
              properties: p.properties,
              confidence: p.confidence,
            }]

            const { allowed, blocked, contradictions } = await runPreStoreGuard(
              orgId, `chief-loop-${Date.now()}`, resolved
            )

            if (allowed.length > 0) {
              await upsertRelationship(
                supabase as any, orgId, `chief-loop-${Date.now()}`,
                p.sourceEntityId, p.targetEntityId,
                {
                  source: p.sourceEntityId,
                  target: p.targetEntityId,
                  type: p.relationshipType,
                  properties: p.properties,
                  confidence: p.confidence,
                }
              )
              r.graphUpdates++
            }

            if (blocked.length > 0) {
              console.warn(`[ChiefLoop:act] Relationship blocked by contradiction guard: ${p.sourceEntityId} -[${p.relationshipType}]-> ${p.targetEntityId}`)
            }

            if (contradictions.length > 0) {
              console.warn(`[ChiefLoop:act] ${contradictions.length} contradiction(s) detected for relationship ${p.sourceEntityId} -[${p.relationshipType}]-> ${p.targetEntityId}`)
              await logChiefLoopEvent(supabase, orgId, leaseId, 'contradiction_detected', {
                targetType: 'relationship',
                targetId: `${p.sourceEntityId}:${p.relationshipType}:${p.targetEntityId}`,
                rationale: `Pre-store guard found ${contradictions.length} contradiction(s)`,
                metadata: { contradictions: contradictions.slice(0, 5) },
              })
            }
          } catch (err) {
            console.error('[ChiefLoop:act] create_relationship error:', err)
            r.errors++
          }
          break
        }

        case 'update_entity': {
          if (r.graphUpdates >= MAX_GRAPH_UPDATES_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            entityId: string; description?: string
            attributes?: Record<string, unknown>
          }
          try {
            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
            }
            if (p.description) updates.description = p.description
            if (p.attributes) updates.attributes = p.attributes as Json

            await supabase
              .from('entities')
              .update(updates)
              .eq('id', p.entityId)
              .eq('org_id', orgId)

            // Regenerate embedding if description changed
            if (p.description) {
              const { data: entity } = await supabase
                .from('entities')
                .select('name, entity_type')
                .eq('id', p.entityId)
                .single()
              if (entity) {
                const e = entity as { name: string; entity_type: string }
                const embedding = await generateEmbedding(`${e.name}: ${p.description}`)
                if (embedding) {
                  await supabase
                    .from('entities')
                    .update({ embedding: JSON.stringify(embedding) })
                    .eq('id', p.entityId)
                }
              }
            }
            r.graphUpdates++
          } catch (err) {
            console.error('[ChiefLoop:act] update_entity error:', err)
            r.errors++
          }
          break
        }

        case 'escalate_blocker': {
          if (r.blockersEscalated >= MAX_ESCALATIONS_PER_HOUR) { r.deferred++; continue }
          const p = decision.payload as {
            outcomeId: string; stepId: string; userId?: string
            oneClearAsk: string; severity: string
          }
          try {
            // Get outcome title
            const { data: outcome } = await supabase
              .from('outcomes')
              .select('title, owner_user_id')
              .eq('id', p.outcomeId)
              .eq('org_id', orgId)
              .single()

            // Get target user
            let userId = p.userId
            if (!userId) {
              userId = (outcome as any)?.owner_user_id
            }
            if (!userId) {
              // Fall back to first onboarded user
              const { data: profiles } = await supabase
                .from('profiles')
                .select('id')
                .eq('org_id', orgId)
                .not('onboarded_at', 'is', null)
                .limit(1)
              userId = profiles?.[0] ? (profiles[0] as { id: string }).id : undefined
            }

            if (userId) {
              const dmResult = await sendBlockerDM(supabase as any, orgId, userId, {
                outcomeId: p.outcomeId,
                outcomeTitle: (outcome as any)?.title ?? 'Unknown outcome',
                stepId: p.stepId,
                oneClearAsk: p.oneClearAsk,
                severity: p.severity as any ?? 'medium',
                cooldownHours: 4,
              })

              if (dmResult.sent) {
                r.blockersEscalated++
              }
            }
          } catch (err) {
            console.error('[ChiefLoop:act] escalate_blocker error:', err)
            r.errors++
          }
          break
        }

        case 'defer': {
          await logChiefLoopEvent(supabase, orgId, leaseId, 'budget_deferred', {
            targetId: (decision.payload as { candidateId: string }).candidateId,
            rationale: decision.rationale, policyResult: 'deferred',
          })
          r.deferred++
          break
        }

        case 'dismiss': {
          await logChiefLoopEvent(supabase, orgId, leaseId, 'decision_made', {
            targetId: (decision.payload as { candidateId: string }).candidateId,
            rationale: decision.rationale, policyResult: 'allowed',
            metadata: { action: 'dismiss' },
          })
          break
        }
      }

      // Feature 7: Record decision outcome for future evaluation
      try {
        await recordDecisionOutcome(supabase, orgId, leaseId, decision)
      } catch (err) {
        console.error(`[ChiefLoop:act] Failed to record decision outcome (${decision.type}):`, err)
      }
    } catch (error) {
      console.error(`[ChiefLoop:act] Decision error (${decision.type}):`, error)
      r.errors++
    }
  }

  // ── Feature 8: Batch-send notifications for NOTIFY tier decisions ──
  if (pendingNotifications.length > 0) {
    try {
      const queued = await sendBatchedNotifications(supabase, orgId, leaseId, pendingNotifications)
      r.notificationsQueued += queued
    } catch (err) {
      console.error('[ChiefLoop:act] Notification batching error:', err)
    }
  }

  // ── Execute ready steps for ALL executing outcomes ──
  try {
    const stepExecResult = await executeReadySteps(supabase, orgId)
    r.stepsExecuted += stepExecResult.stepsExecuted
    r.errors += stepExecResult.errors
  } catch (error) {
    console.error('[ChiefLoop:act] Step execution error:', error)
    r.error = (error as Error).message
  }

  // ── Escalate any remaining blocked outcomes ──
  try {
    const escResult = await escalateBlockedOutcomes(supabase, orgId)
    r.blockersEscalated += escResult.escalated
  } catch (error) {
    console.error('[ChiefLoop:act] Escalation error:', error)
  }

  r.durationMs = Date.now() - startTime
  return r
}

// ─── Step Execution (within Act phase) ───────────────────────────────────

async function executeReadySteps(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ stepsExecuted: number; errors: number }> {
  let stepsExecuted = 0
  let errors = 0

  // Get all executing outcomes
  const { data: outcomes } = await supabase
    .from('outcomes')
    .select('id')
    .eq('org_id', orgId)
    .eq('status', 'executing')

  if (!outcomes || outcomes.length === 0) return { stepsExecuted, errors }

  // Check budget
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: dbStepsThisHour } = await supabase
    .from('outcome_steps')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('status', ['completed', 'failed'])
    .gte('updated_at', oneHourAgo)
  const budgetRemaining = Math.max(0, MAX_STEP_EXECUTIONS_PER_HOUR - (dbStepsThisHour ?? 0))

  if (budgetRemaining === 0) {
    console.log(`[ChiefLoop:act] Step budget exhausted for org ${orgId}: ${dbStepsThisHour}/${MAX_STEP_EXECUTIONS_PER_HOUR} this hour`)
    return { stepsExecuted, errors }
  }

  for (const outcome of outcomes) {
    if (stepsExecuted >= budgetRemaining) break

    const outcomeId = (outcome as { id: string }).id
    const plan = await getOutcomeWithPlan(outcomeId, orgId)
    if (!plan?.run || plan.run.status !== 'active') continue

    const readySteps = await getNextExecutableSteps(plan.run.id)

    for (const step of readySteps) {
      if (stepsExecuted >= budgetRemaining) break

      // Safety gate: never auto-execute external tools
      const stepRiskClass = (step as any).riskClass ?? 'internal'
      if (step.toolName && (EXTERNAL_TOOLS.includes(step.toolName) || stepRiskClass === 'external')) {
        if (step.status === 'pending') {
          await updateStep(step.id, {
            status: 'blocked',
            blockerType: 'approval_pending',
          }, orgId)
        }
        continue
      }

      // tool_call — execute directly
      if (step.actionType === 'tool_call' && step.toolName) {
        const execResult = await executeToolDirectly(
          orgId, step.toolName,
          (step.toolArgs as Record<string, unknown>) ?? {},
          { timeoutMs: 30_000 }
        )

        await updateStep(step.id, {
          status: execResult.success ? 'completed' : 'failed',
          resultSummary: execResult.summary,
          errorMessage: execResult.error ?? null,
        }, orgId)

        if (execResult.success) stepsExecuted++
        else errors++
        continue
      }

      // llm_reasoning — run headless captain
      if (step.actionType === 'llm_reasoning') {
        try {
          const { runHeadlessCaptain } = await import('@/lib/agent/runtime/headless-captain')
          const headlessResult = await runHeadlessCaptain(orgId, `Execute step: ${step.description}`, {
            maxTurns: 10,
            timeoutMs: 60_000,
          })

          if (headlessResult.error) {
            await updateStep(step.id, {
              status: 'failed',
              errorMessage: `Headless reasoning failed: ${headlessResult.error}`,
            }, orgId)
            errors++
          } else {
            await updateStep(step.id, {
              status: 'completed',
              resultSummary: headlessResult.text.slice(0, 2000),
            }, orgId)
            stepsExecuted++
          }
        } catch (err) {
          await updateStep(step.id, {
            status: 'failed',
            errorMessage: `Headless error: ${(err as Error).message}`,
          }, orgId)
          errors++
        }
        continue
      }

      // wait_input / wait_approval — mark blocked
      if (step.actionType === 'wait_input' || step.actionType === 'wait_approval') {
        if (step.status === 'pending') {
          await updateStep(step.id, {
            status: 'blocked',
            blockerType: step.actionType === 'wait_input' ? 'input_needed' : 'approval_pending',
          }, orgId)
        }
      }
    }

    // Reconcile outcome status
    await reconcileOutcomeStatus(orgId, outcomeId, plan.run.id)
  }

  return { stepsExecuted, errors }
}

// ─── Blocker Escalation (within Act phase) ───────────────────────────────

async function escalateBlockedOutcomes(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ escalated: number }> {
  let escalated = 0

  const { data: blockedOutcomes } = await supabase
    .from('outcomes')
    .select('id, title, owner_user_id, blocker_summary')
    .eq('org_id', orgId)
    .eq('status', 'blocked')

  if (!blockedOutcomes || blockedOutcomes.length === 0) return { escalated }

  // Get default user
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .not('onboarded_at', 'is', null)
    .limit(1)
  const defaultUserId = profiles?.[0] ? (profiles[0] as { id: string }).id : null
  if (!defaultUserId) return { escalated }

  for (const outcome of blockedOutcomes) {
    const o = outcome as { id: string; title: string; owner_user_id: string | null; blocker_summary: string | null }
    if (!o.blocker_summary) continue

    const userId = o.owner_user_id ?? defaultUserId
    const plan = await getOutcomeWithPlan(o.id, orgId)
    if (!plan?.run) continue

    const blockedSteps = plan.steps.filter(s => s.status === 'blocked' && s.oneClearAsk)

    for (const step of blockedSteps) {
      const dmResult = await sendBlockerDM(supabase as any, orgId, userId, {
        outcomeId: o.id,
        outcomeTitle: o.title,
        stepId: step.id,
        oneClearAsk: step.oneClearAsk!,
        severity: plan.outcome.priority === 'critical' ? 'critical' : 'medium',
        cooldownHours: 4,
      })

      if (dmResult.sent) escalated++
    }
  }

  return { escalated }
}

// ─── Feature 8: Batched Notifications (NOTIFY tier) ──────────────────────
// After all decisions are processed, batch-insert notification rows for
// NOTIFY-tier decisions and send a single Slack DM summary to the org owner.

async function sendBatchedNotifications(
  supabase: SupabaseClient,
  orgId: string,
  leaseId: string,
  notifications: Array<{
    decisionType: string; decisionSummary: string; riskScore: number
    targetType?: string; targetId?: string
  }>
): Promise<number> {
  if (notifications.length === 0) return 0

  // Insert notification rows
  const rows = notifications.map(n => ({
    org_id: orgId,
    lease_id: leaseId,
    decision_type: n.decisionType,
    decision_summary: n.decisionSummary,
    risk_score: n.riskScore,
    target_type: n.targetType ?? null,
    target_id: n.targetId ?? null,
    notification_channel: 'slack' as const,
    status: 'pending' as const,
  }))

  const { error: insertError } = await supabase
    .from('chief_loop_notifications')
    .insert(rows)

  if (insertError) {
    console.error('[ChiefLoop:notify] Failed to insert notifications:', insertError.message)
    return 0
  }

  // Send a single batched Slack DM to the org owner
  try {
    // Find the org owner (first onboarded user)
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id')
      .eq('org_id', orgId)
      .not('onboarded_at', 'is', null)
      .limit(1)
    const ownerId = profiles?.[0] ? (profiles[0] as { id: string }).id : null
    if (!ownerId) return notifications.length

    // Get Slack tokens
    const slackTokens = await TokenManager.getTokens(orgId, 'slack')
    if (!slackTokens) return notifications.length

    // Get user's Slack ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('slack_user_id')
      .eq('id', ownerId)
      .single()
    const slackUserId = (profile as { slack_user_id?: string } | null)?.slack_user_id
    if (!slackUserId) return notifications.length

    // Build summary message
    const lines = notifications.map(n =>
      `• *${n.decisionType}* (risk: ${n.riskScore.toFixed(2)}): ${n.decisionSummary.slice(0, 150)}`
    )
    const message = `🔔 *Chief Loop Notification* — ${notifications.length} decision(s) executed:\n\n${lines.join('\n')}\n\n_These ran automatically. Review in your dashboard if needed._`

    const client = new WebClient(slackTokens.user_access_token || slackTokens.access_token)
    await client.chat.postMessage({
      channel: slackUserId,
      text: message,
    })

    // Mark notifications as sent
    const sentAt = new Date().toISOString()
    await supabase
      .from('chief_loop_notifications')
      .update({ status: 'sent', sent_at: sentAt })
      .eq('org_id', orgId)
      .eq('lease_id', leaseId)
      .eq('status', 'pending')

    console.log(`[ChiefLoop:notify] Sent ${notifications.length} notification(s) to Slack user ${slackUserId}`)
  } catch (err) {
    console.error('[ChiefLoop:notify] Slack notification error:', err)
    // Mark as failed
    await supabase
      .from('chief_loop_notifications')
      .update({ status: 'failed' })
      .eq('org_id', orgId)
      .eq('lease_id', leaseId)
      .eq('status', 'pending')
  }

  return notifications.length
}

// ─── Feature 7: Decision Outcome Tracking ─────────────────────────────────
// Records predictions at decision time, auto-evaluates after delay.

/** Determine when to auto-evaluate a decision based on its type */
function getEvaluateAfter(decisionType: string): Date {
  const now = Date.now()
  switch (decisionType) {
    case 'execute_step':
      return new Date(now + 5 * 60 * 1000)          // 5 minutes (step should complete quickly)
    case 'skip_step':
    case 'block_step':
      return new Date(now + 2 * 60 * 60 * 1000)     // 2 hours
    case 'defer':
      return new Date(now + 2 * 60 * 60 * 1000)     // 2 hours
    case 'dismiss':
      return new Date(now + 24 * 60 * 60 * 1000)    // 24 hours (check if signal reappeared)
    case 'create_outcome':
      return new Date(now + 24 * 60 * 60 * 1000)    // 24 hours
    case 'branch_replan':
      return new Date(now + 12 * 60 * 60 * 1000)    // 12 hours
    case 'escalate_blocker':
      return new Date(now + 4 * 60 * 60 * 1000)     // 4 hours
    case 'store_insight':
    case 'store_memory':
      return new Date(now + 48 * 60 * 60 * 1000)    // 48 hours (long-term value)
    default:
      return new Date(now + 24 * 60 * 60 * 1000)    // Default: 24 hours
  }
}

/** Record a decision outcome row for future evaluation */
async function recordDecisionOutcome(
  supabase: SupabaseClient,
  orgId: string,
  leaseId: string,
  decision: ChiefDecision
): Promise<void> {
  const payload = decision.payload as Record<string, unknown>
  const targetType =
    payload.outcomeId ? 'outcome' :
    payload.stepId ? 'step' :
    payload.entityId ? 'entity' :
    payload.candidateId ? 'signal' :
    undefined
  const targetId = (payload.outcomeId ?? payload.stepId ?? payload.entityId ?? payload.candidateId) as string | undefined

  await supabase.from('decision_outcomes').insert({
    org_id: orgId,
    lease_id: leaseId,
    decision_type: decision.type,
    decision_payload: decision.payload,
    decision_rationale: decision.rationale?.slice(0, 1000),
    risk_score: decision.riskScore ?? null,
    prediction: decision.expectedOutcome ?? null,
    prediction_confidence: decision.riskScore != null ? (1 - decision.riskScore) : null,
    target_type: targetType ?? null,
    target_id: targetId ?? null,
    evaluate_after: getEvaluateAfter(decision.type).toISOString(),
  })
}

/** Auto-evaluate mature pending decisions. Returns number evaluated. */
async function evaluatePendingDecisions(
  supabase: SupabaseClient,
  orgId: string
): Promise<number> {
  const now = new Date().toISOString()

  // Fetch decisions ready for evaluation
  const { data: pending } = await supabase
    .from('decision_outcomes')
    .select('id, decision_type, target_type, target_id, prediction')
    .eq('org_id', orgId)
    .is('accuracy_score', null)
    .lte('evaluate_after', now)
    .limit(50)

  if (!pending || pending.length === 0) return 0

  let evaluated = 0

  for (const row of pending) {
    const d = row as {
      id: string; decision_type: string
      target_type: string | null; target_id: string | null
      prediction: string | null
    }

    let accuracyScore: number | null = null
    let actualResult = ''
    let evaluationMethod = ''

    try {
      switch (d.decision_type) {
        case 'execute_step': {
          if (!d.target_id) break
          const { data: step } = await supabase
            .from('outcome_steps')
            .select('status')
            .eq('id', d.target_id)
            .single()
          if (!step) break
          const s = (step as { status: string }).status
          if (s === 'completed') { accuracyScore = 1.0; actualResult = 'Step completed successfully' }
          else if (s === 'failed') { accuracyScore = 0.0; actualResult = 'Step failed' }
          else if (s === 'skipped') { accuracyScore = 0.3; actualResult = 'Step was skipped' }
          else { continue } // Still pending — skip for now
          evaluationMethod = 'auto_step_result'
          break
        }

        case 'create_outcome': {
          if (!d.target_id) break
          const { data: outcome } = await supabase
            .from('outcomes')
            .select('status')
            .eq('id', d.target_id)
            .single()
          if (!outcome) break
          const s = (outcome as { status: string }).status
          if (s === 'completed') { accuracyScore = 1.0; actualResult = 'Outcome completed' }
          else if (s === 'blocked') { accuracyScore = 0.3; actualResult = 'Outcome blocked' }
          else if (s === 'failed' || s === 'cancelled') { accuracyScore = 0.0; actualResult = `Outcome ${s}` }
          else if (s === 'executing') { accuracyScore = 0.7; actualResult = 'Outcome still executing (positive signal)' }
          else { continue } // Still planning — check next cycle
          evaluationMethod = 'auto_outcome_status'
          break
        }

        case 'dismiss': {
          // Check if the signal reappeared: search for similar insights/findings since dismissal
          if (!d.target_id) { accuracyScore = 0.5; actualResult = 'No target to track'; evaluationMethod = 'auto_ttl_expired'; break }
          const { count } = await supabase
            .from('graph_insights')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', orgId)
            .ilike('summary', `%${d.target_id.slice(0, 50)}%`)
            .gte('created_at', now)
          if ((count ?? 0) > 0) { accuracyScore = 0.0; actualResult = 'Signal reappeared after dismissal' }
          else { accuracyScore = 1.0; actualResult = 'Signal stayed dismissed' }
          evaluationMethod = 'auto_signal_recheck'
          break
        }

        case 'defer': {
          // Deferred items: check if they were eventually processed
          accuracyScore = 0.5 // Neutral — defers are hard to auto-evaluate
          actualResult = 'Deferred item evaluation (neutral)'
          evaluationMethod = 'auto_ttl_expired'
          break
        }

        default: {
          // For other types (store_insight, store_memory, graph ops), give neutral score
          accuracyScore = 0.5
          actualResult = `Auto-evaluated: ${d.decision_type} (neutral default)`
          evaluationMethod = 'auto_ttl_expired'
        }
      }

      if (accuracyScore !== null) {
        await supabase
          .from('decision_outcomes')
          .update({
            accuracy_score: accuracyScore,
            actual_result: actualResult,
            evaluated_at: now,
            evaluation_method: evaluationMethod,
          })
          .eq('id', d.id)
        evaluated++
      }
    } catch (err) {
      console.error(`[ChiefLoop:eval] Error evaluating decision ${d.id}:`, err)
    }
  }

  if (evaluated > 0) {
    console.log(`[ChiefLoop:eval] Auto-evaluated ${evaluated} decision outcomes for org ${orgId}`)
  }

  return evaluated
}

/** Fetch aggregated accuracy stats by decision type (last 30 days) */
async function fetchAccuracyStats(
  supabase: SupabaseClient,
  orgId: string
): Promise<Record<string, { avg: number; count: number }> | null> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data } = await supabase
    .from('decision_outcomes')
    .select('decision_type, accuracy_score')
    .eq('org_id', orgId)
    .not('accuracy_score', 'is', null)
    .gte('created_at', thirtyDaysAgo)

  if (!data || data.length === 0) return null

  // Aggregate by type
  const stats: Record<string, { sum: number; count: number }> = {}
  for (const row of data) {
    const r = row as { decision_type: string; accuracy_score: number }
    if (!stats[r.decision_type]) {
      stats[r.decision_type] = { sum: 0, count: 0 }
    }
    stats[r.decision_type].sum += r.accuracy_score
    stats[r.decision_type].count++
  }

  const result: Record<string, { avg: number; count: number }> = {}
  for (const [type, s] of Object.entries(stats)) {
    result[type] = { avg: s.sum / s.count, count: s.count }
  }

  return result
}

// ─── Phase E: Reflect (Feature 12) ───────────────────────────────────────
// Lightweight self-reflection after ACT: compares decisions with previous
// outcomes and stores reusable procedural memories. 30s timeout, 5 turns max.

interface ReflectResult {
  durationMs: number
  memoriesStored: number
  error?: string
}

async function phaseReflect(
  supabase: SupabaseClient,
  orgId: string,
  decisions: ChiefDecision[],
  gatherResult: GatherResult,
  previousCarryForward: string | null,
  collector?: StepCollector
): Promise<ReflectResult> {
  const startTime = Date.now()

  // Skip reflection if no meaningful decisions were made
  if (decisions.length === 0) {
    return { durationMs: 0, memoriesStored: 0 }
  }

  try {
    const { runReflectionAgent } = await import('@/lib/agent/openai/chief-sub-agents')

    const reflectInput = {
      decisions,
      activeOutcomes: gatherResult.activeOutcomes,
      previousCarryForward,
      proceduralMemories: gatherResult.proceduralMemories,
    }

    const reflectResult = await Promise.race([
      runReflectionAgent(orgId, reflectInput, collector),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Reflection timed out (30s)')), 30_000)
      ),
    ])

    // Persist any procedural memories the reflection agent produced
    let memoriesStored = 0
    for (const pm of reflectResult.newProceduralMemories) {
      try {
        const embedding = await generateEmbedding(pm.triggerPattern + ' ' + pm.successfulApproach)
        await supabase.from('procedural_memory').insert({
          org_id: orgId,
          trigger_pattern: pm.triggerPattern,
          successful_approach: pm.successfulApproach,
          context_tags: pm.contextTags,
          embedding,
        })
        memoriesStored++
      } catch (insertErr) {
        console.error('[ChiefLoop:reflect] Failed to store procedural memory:', insertErr)
      }
    }

    console.log(`[ChiefLoop:reflect] Done: ${memoriesStored} procedural memories stored, ${reflectResult.durationMs}ms`)
    return { durationMs: Date.now() - startTime, memoriesStored }
  } catch (error) {
    console.error('[ChiefLoop:reflect] Error:', error)
    return { durationMs: Date.now() - startTime, memoriesStored: 0, error: (error as Error).message }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function logChiefLoopEvent(
  supabase: SupabaseClient,
  orgId: string,
  leaseId: string,
  eventType: string,
  opts?: {
    targetType?: string
    targetId?: string
    rationale?: string
    policyResult?: string
    policyReason?: string
    metadata?: Record<string, unknown>
    riskScore?: number
  }
): Promise<void> {
  try {
    await supabase.from('chief_loop_events').insert({
      org_id: orgId,
      lease_id: leaseId,
      event_type: eventType,
      target_type: opts?.targetType ?? null,
      target_id: opts?.targetId ?? null,
      rationale: opts?.rationale ?? null,
      policy_result: opts?.policyResult ?? null,
      policy_reason: opts?.policyReason ?? null,
      metadata: opts?.metadata ?? {},
      risk_score: opts?.riskScore ?? null,
    })
  } catch (error) {
    console.error(`[ChiefLoop] Event log error:`, error)
  }
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  // MiniMax M2.5 pricing via OpenRouter (approximate)
  return (inputTokens * 0.000002 + outputTokens * 0.000008)
}

