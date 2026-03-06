/**
 * Chief Loop v2 — Unified Hourly Intelligence Runtime
 *
 * Single entrypoint: runChiefLoopForOrg(orgId, now)
 *
 * 5 Phases:
 *   A. LOCK     — Acquire org lease, skip if busy
 *   B. GATHER   — Fetch ALL raw data (zero LLM, pure SQL + integration API reads)
 *   C. THINK    — LLM agent analyzes everything, makes decisions
 *   D. ACT      — Execute decisions (steps, graph updates, escalations)
 *   E. CLOSEOUT — Persist metrics, release lease, emit events
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
import { EXTERNAL_TOOLS } from '@/lib/agent/planner/plan-validator'

// Nudge engine (blocker DM)
import { sendBlockerDM } from '@/lib/intelligence/nudge-engine'

// Worker execution logging
import { logWorkerExecution, completeWorkerExecution } from '@/lib/agent/hooks'

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

  try {
    // ═════════════════════════════════════════════════════════════════════
    // Phase B: GATHER — Fetch ALL raw data (zero LLM)
    // ═════════════════════════════════════════════════════════════════════
    const gatherResult = await phaseGather(supabase, orgId, now)
    result.phases.gather = { durationMs: gatherResult.durationMs }
    if (gatherResult.error) result.phases.gather.error = gatherResult.error
    result.signalsGathered = gatherResult.totalSignals

    // ═════════════════════════════════════════════════════════════════════
    // Phase C: THINK — LLM agent analyzes everything
    // ═════════════════════════════════════════════════════════════════════
    const thinkResult = await phaseThink(supabase, orgId, now, gatherResult)
    result.phases.think = { durationMs: thinkResult.durationMs }
    if (thinkResult.error) result.phases.think.error = thinkResult.error
    result.costUsd += thinkResult.costUsd

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

  } catch (error) {
    console.error(`[ChiefLoop] Unhandled error for org ${orgId}:`, error)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase E: CLOSEOUT — Persist metrics, release lease
  // ═══════════════════════════════════════════════════════════════════════
  const closeoutStart = Date.now()
  result.durationMs = closeoutStart - startTime

  // Release lease
  try {
    await releaseLease(supabase, leaseId, result)
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

  // Complete worker execution
  try {
    if (executionId) {
      await completeWorkerExecution(executionId, {
        status: 'completed',
        output_summary: `signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} deferred=${result.deferredItems}`,
        duration_ms: result.durationMs,
        cost_usd: result.costUsd,
      })
    }
  } catch (error) {
    console.error(`[ChiefLoop] Worker execution completion failed for org ${orgId}:`, error)
  }

  result.phases.closeout = { durationMs: Date.now() - closeoutStart }
  result.durationMs = Date.now() - startTime

  console.log(
    `[ChiefLoop] org=${orgId}: signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} steps=${result.stepsExecuted} blockers=${result.blockersEscalated} graph=${result.graphUpdates} cost=$${result.costUsd.toFixed(4)} (${result.durationMs}ms)`
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
  result: ChiefLoopResult
): Promise<void> {
  const { error } = await supabase.rpc('release_chief_lease', {
    p_lease_id: leaseId,
    p_status: 'completed',
    p_result_summary: `signals=${result.signalsGathered} replans=${result.replans} outcomes=${result.newOutcomes} steps=${result.stepsExecuted} graph=${result.graphUpdates}`,
    p_signals_ingested: result.signalsGathered,
    p_outcomes_created: result.newOutcomes,
    p_steps_executed: result.stepsExecuted,
    p_cost_usd: result.costUsd,
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
        console.error('[ChiefLoop:gather] worker views error:', e)
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
    ])

    r.orgName = orgData?.name ?? 'Unknown'
    r.activeOutcomes = outcomes
    r.recentEmails = emails
    r.recentSlackMessages = slackMessages
    r.todayEvents = calendarEvents
    r.workerViews = workerViews
    r.connectedIntegrations = integrations

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
  gather: GatherResult
): Promise<ThinkResult> {
  const startTime = Date.now()
  const r: ThinkResult = { durationMs: 0, decisions: [], costUsd: 0 }

  // Skip if no worker views (org not properly set up)
  if (!gather.workerViews) {
    r.durationMs = Date.now() - startTime
    return r
  }

  try {
    const { runChiefAnalyst } = await import('@/lib/agent/openai/chief-analyst-agent')

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
      workerViews: gather.workerViews,
      connectedIntegrations: gather.connectedIntegrations,
    }

    // Timeout: abort if agent takes too long
    const agentResult = await Promise.race([
      runChiefAnalyst(input),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Chief analyst timed out after ${AGENT_TIMEOUT_MS / 1000}s`)), AGENT_TIMEOUT_MS)
      ),
    ])

    r.decisions = agentResult.decisions
    r.costUsd = estimateCost(agentResult.usage.input, agentResult.usage.output)

    console.log(`[ChiefLoop:think] Agent completed: ${agentResult.decisions.length} decisions, ${agentResult.turns} turns, ${agentResult.durationMs}ms`)
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
  }

  // ── Per-decision-type rate limits ──
  const MAX_GRAPH_UPDATES_PER_HOUR = 30
  const MAX_INSIGHTS_PER_HOUR = 15
  const MAX_MEMORIES_PER_HOUR = 15
  const MAX_REPLANS_PER_HOUR = 3
  const MAX_ESCALATIONS_PER_HOUR = 5
  let insightsCreated = 0
  let memoriesCreated = 0

  // ── Process agent decisions ──
  for (const decision of decisions) {
    try {
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
    } catch (error) {
      console.error(`[ChiefLoop:act] Decision error (${decision.type}):`, error)
      r.errors++
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
    })
  } catch (error) {
    console.error(`[ChiefLoop] Event log error:`, error)
  }
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  // MiniMax M2.5 pricing via OpenRouter (approximate)
  return (inputTokens * 0.000002 + outputTokens * 0.000008)
}
