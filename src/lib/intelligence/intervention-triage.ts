/**
 * Proactive Intervention Engine — Phase C of Chief-of-Staff Agent V1.
 *
 * Replaces threshold-only routing with LLM-informed triage decisions.
 * Classifies every potential intervention as:
 *   - interrupt_now:  High-impact, time-sensitive → immediate nudge
 *   - defer_brief:    Important but can wait → include in next brief
 *   - watch:          Track silently → only surface if persists
 *
 * Anti-spam: Tracks prior interventions and user responses to avoid
 * re-alerting on things the user has already dismissed or ignored.
 *
 * All writes are fire-and-forget safe.
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ────────────────────────────────────────────────────────────────

export type TriageDecision = 'interrupt_now' | 'defer_brief' | 'watch'

export type InterventionSourceType =
  | 'patrol_finding'
  | 'graph_insight'
  | 'calendar_event'
  | 'deadline'
  | 'stale_blocker'
  | 'integration_event'
  | 'outcome_blocked'

export type UserResponseType = 'accepted' | 'deferred' | 'ignored' | 'rejected'

export interface TriageParams {
  orgId: string
  userId: string
  sourceType: InterventionSourceType
  sourceId?: string
  sourceSummary: string
  // Optional pre-computed context
  userImpact?: string
  timingSensitivity?: string
}

export interface TriageResult {
  id: string
  decision: TriageDecision
  confidence: number
  rationale: string
  recommendedChannel: 'chat' | 'slack' | 'brief' | 'email' | null
  suppressed: boolean           // True if anti-spam blocked it
  suppressionReason?: string
}

export interface InterventionHistory {
  interventionType: string
  totalCount: number
  acceptedCount: number
  ignoredCount: number
  rejectedCount: number
  lastInterventionAt: string | null
  acceptanceRate: number
}

// ─── Anti-Spam Check ──────────────────────────────────────────────────────

/**
 * Check prior intervention history to determine if we should suppress.
 * Returns null if allowed, or a reason string if suppressed.
 */
export async function checkAntiSpam(
  orgId: string,
  userId: string,
  sourceCategory: string
): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .rpc('get_intervention_history', {
        p_org_id: orgId,
        p_user_id: userId,
        p_source_category: sourceCategory,
        p_days: 30,
      })

    if (error || !data || data.length === 0) return null

    const history = data[0] as Record<string, unknown>
    const total = (history.total_count as number) ?? 0
    const rejectedCount = (history.rejected_count as number) ?? 0
    const ignoredCount = (history.ignored_count as number) ?? 0
    const acceptanceRate = (history.acceptance_rate as number) ?? 1.0
    const lastAt = history.last_intervention_at as string | null

    // Rule 1: If user rejected 3+ times in this category, suppress
    if (rejectedCount >= 3) {
      return `User rejected ${rejectedCount} interventions in "${sourceCategory}" — suppressing`
    }

    // Rule 2: If acceptance rate < 20% with enough samples, suppress
    if (total >= 5 && acceptanceRate < 0.2) {
      return `Acceptance rate ${(acceptanceRate * 100).toFixed(0)}% in "${sourceCategory}" — suppressing`
    }

    // Rule 3: If same category nudged within 4 hours, suppress
    if (lastAt) {
      const hoursSinceLast = (Date.now() - new Date(lastAt).getTime()) / (1000 * 60 * 60)
      if (hoursSinceLast < 4) {
        return `Last intervention in "${sourceCategory}" was ${hoursSinceLast.toFixed(1)}h ago — cooldown`
      }
    }

    // Rule 4: If ignored 5+ times consecutively, suppress
    if (ignoredCount >= 5 && rejectedCount === 0 && (history.accepted_count as number) === 0) {
      return `User ignored all ${ignoredCount} interventions in "${sourceCategory}" — suppressing`
    }

    return null
  } catch (error) {
    console.error('[InterventionTriage] Anti-spam check failed:', error)
    return null // Fail open — allow the intervention
  }
}

// ─── Triage Engine ────────────────────────────────────────────────────────

/**
 * Triage a potential intervention. Decides interrupt/defer/watch.
 *
 * Uses rule-based scoring (no LLM call — keeps latency <5ms).
 * LLM triage can be added as an upgrade path for ambiguous cases.
 */
export async function triageIntervention(
  params: TriageParams
): Promise<TriageResult> {
  const { orgId, userId, sourceType, sourceId, sourceSummary } = params

  // Step 1: Anti-spam check
  const suppressionReason = await checkAntiSpam(orgId, userId, sourceType)

  if (suppressionReason) {
    // Still record the triage for observability, but mark as suppressed
    const id = await persistTriage({
      orgId,
      userId,
      sourceType,
      sourceId,
      sourceSummary,
      triageDecision: 'watch',
      scoringRationale: `Suppressed: ${suppressionReason}`,
      confidence: 0.9,
      userImpact: params.userImpact,
      timingSensitivity: params.timingSensitivity,
      recommendedChannel: null,
      routedTo: 'none',
    })

    return {
      id: id ?? '',
      decision: 'watch',
      confidence: 0.9,
      rationale: suppressionReason,
      recommendedChannel: null,
      suppressed: true,
      suppressionReason,
    }
  }

  // Step 2: Score the intervention
  const score = scoreIntervention(params)

  // Step 3: Map score to decision
  let decision: TriageDecision
  let recommendedChannel: 'chat' | 'slack' | 'brief' | 'email' | null

  if (score.urgency >= 0.8) {
    decision = 'interrupt_now'
    recommendedChannel = 'slack'
  } else if (score.urgency >= 0.5) {
    decision = 'defer_brief'
    recommendedChannel = 'brief'
  } else {
    decision = 'watch'
    recommendedChannel = null
  }

  // Step 4: Determine routing
  let routedTo = 'none'
  if (decision === 'interrupt_now') routedTo = 'nudge'
  else if (decision === 'defer_brief') routedTo = 'brief'

  // Step 5: Persist
  const id = await persistTriage({
    orgId,
    userId,
    sourceType,
    sourceId,
    sourceSummary,
    triageDecision: decision,
    scoringRationale: score.rationale,
    confidence: score.confidence,
    userImpact: params.userImpact ?? score.userImpact,
    timingSensitivity: params.timingSensitivity ?? score.timingSensitivity,
    recommendedChannel,
    routedTo,
  })

  return {
    id: id ?? '',
    decision,
    confidence: score.confidence,
    rationale: score.rationale,
    recommendedChannel,
    suppressed: false,
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────

interface InterventionScore {
  urgency: number       // 0-1
  confidence: number    // 0-1
  rationale: string
  userImpact: string
  timingSensitivity: string
}

function scoreIntervention(params: TriageParams): InterventionScore {
  const { sourceType, sourceSummary } = params
  let urgency = 0.5
  let rationale = ''
  let userImpact = 'moderate'
  let timingSensitivity = 'standard'

  // Base urgency by source type
  switch (sourceType) {
    case 'deadline':
      urgency = 0.85
      rationale = 'Deadline-related — time-sensitive by nature'
      userImpact = 'high'
      timingSensitivity = 'urgent'
      break
    case 'outcome_blocked':
      urgency = 0.75
      rationale = 'Active outcome blocked — user action needed'
      userImpact = 'high'
      timingSensitivity = 'soon'
      break
    case 'patrol_finding':
      urgency = 0.6
      rationale = 'Patrol finding — routine monitoring'
      break
    case 'graph_insight':
      urgency = 0.45
      rationale = 'Knowledge graph insight — informational'
      userImpact = 'low'
      break
    case 'stale_blocker':
      urgency = 0.65
      rationale = 'Stale blocker detected — may need attention'
      timingSensitivity = 'soon'
      break
    case 'calendar_event':
      urgency = 0.7
      rationale = 'Calendar-related — time-bound'
      timingSensitivity = 'soon'
      break
    case 'integration_event':
      urgency = 0.5
      rationale = 'Integration event — external system update'
      break
  }

  // Keyword boosters in summary
  const lowerSummary = sourceSummary.toLowerCase()
  if (lowerSummary.includes('critical') || lowerSummary.includes('urgent')) urgency += 0.15
  if (lowerSummary.includes('overdue')) urgency += 0.1
  if (lowerSummary.includes('failing') || lowerSummary.includes('failed')) urgency += 0.1
  if (lowerSummary.includes('blocked')) urgency += 0.1
  if (lowerSummary.includes('risk') || lowerSummary.includes('vulnerability')) urgency += 0.1

  // Cap at 1.0
  urgency = Math.min(1.0, urgency)

  // Confidence is higher for rule-based decisions
  const confidence = urgency >= 0.8 || urgency < 0.4 ? 0.85 : 0.65

  return { urgency, confidence, rationale, userImpact, timingSensitivity }
}

// ─── Feedback Recording ───────────────────────────────────────────────────

/**
 * Record user response to an intervention. Used for anti-spam learning.
 */
export async function recordInterventionFeedback(
  orgId: string,
  userId: string,
  triageId: string | null,
  interventionType: string,
  interventionSummary: string,
  userResponse: UserResponseType,
  sourceCategory?: string,
  responseLatencyMs?: number
): Promise<void> {
  try {
    const supabase = createAdminClient()

    await supabase.from('intervention_feedback').insert({
      org_id: orgId,
      user_id: userId,
      triage_id: triageId,
      intervention_type: interventionType,
      intervention_summary: interventionSummary,
      user_response: userResponse,
      source_category: sourceCategory ?? interventionType,
      response_latency_ms: responseLatencyMs ?? null,
      responded_at: userResponse !== 'ignored' ? new Date().toISOString() : null,
    })
  } catch (error) {
    console.error('[InterventionTriage] Failed to record feedback:', error)
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────

interface PersistTriageParams {
  orgId: string
  userId: string
  sourceType: InterventionSourceType
  sourceId?: string
  sourceSummary: string
  triageDecision: TriageDecision
  scoringRationale: string
  confidence: number
  userImpact?: string
  timingSensitivity?: string
  recommendedChannel: 'chat' | 'slack' | 'brief' | 'email' | null
  routedTo: string
}

async function persistTriage(params: PersistTriageParams): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('intervention_triage')
      .insert({
        org_id: params.orgId,
        user_id: params.userId,
        source_type: params.sourceType,
        source_id: params.sourceId ?? null,
        source_summary: params.sourceSummary,
        triage_decision: params.triageDecision,
        scoring_rationale: params.scoringRationale,
        confidence: params.confidence,
        user_impact: params.userImpact ?? null,
        timing_sensitivity: params.timingSensitivity ?? null,
        recommended_channel: params.recommendedChannel,
        routed_to: params.routedTo,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[InterventionTriage] Failed to persist triage:', error.message)
      return null
    }
    return data.id
  } catch (error) {
    console.error('[InterventionTriage] Exception persisting triage:', error)
    return null
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────

/**
 * Get recent triage decisions for a user (for observability / debugging).
 */
export async function getRecentTriageDecisions(
  orgId: string,
  userId: string,
  limit = 20
): Promise<Array<{
  id: string
  sourceType: string
  sourceSummary: string
  decision: TriageDecision
  confidence: number
  rationale: string
  createdAt: string
}>> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('intervention_triage')
      .select('id, source_type, source_summary, triage_decision, confidence, scoring_rationale, created_at')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error || !data) return []

    return data.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      sourceSummary: row.source_summary,
      decision: row.triage_decision as TriageDecision,
      confidence: row.confidence,
      rationale: row.scoring_rationale ?? '',
      createdAt: row.created_at,
    }))
  } catch {
    return []
  }
}
