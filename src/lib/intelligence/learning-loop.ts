/**
 * Learning Loop — Phase E of Chief-of-Staff Agent V1.
 *
 * Self-improving agency through:
 * 1. Outcome impact tracking — Did insights/decisions lead to good outcomes?
 * 2. User preference learning — Infer timing, style, risk tolerance
 * 3. Weekly bounded tuning — Adjust thresholds within guardrails
 *
 * All writes are fire-and-forget safe. Learning never modifies safety rules.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export type ImpactType =
  | 'insight_led_to_action'
  | 'decision_led_to_outcome'
  | 'context_improved_response'
  | 'intervention_prevented_risk'
  | 'false_positive'

export type InterventionTiming = 'aggressive' | 'moderate' | 'conservative'
export type MessageStyle = 'brief' | 'detailed' | 'analytical'
export type EscalationPreference = 'escalate_early' | 'moderate' | 'escalate_late'

export interface OutcomeImpactParams {
  orgId: string
  outcomeId: string
  insightId?: string
  decisionCardId?: string
  entityId?: string
  impactType: ImpactType
  impactRating?: number          // 1-5
  impactNotes?: string
  actionTakenAt?: string
  outcomeAchievedAt?: string
}

export interface UserPreferences {
  interventionTiming: InterventionTiming
  messageStyle: MessageStyle
  riskTolerance: number          // 0-1
  escalationPreference: EscalationPreference
  source: 'default' | 'explicit' | 'learned'
  confidence: number
  sampleSize: number
}

export interface TuningProposal {
  parameter: string
  currentValue: string | number
  proposedValue: string | number
  rationale: string
  evidence: string
  guardrailCheck: 'pass' | 'blocked'
  blockedReason?: string
}

export interface WeeklyTuningResult {
  weekStart: string
  totalInteractions: number
  acceptanceRate: number
  falsePositiveRate: number
  proposals: TuningProposal[]
  appliedChanges: TuningProposal[]
  guardrailViolations: TuningProposal[]
}

// ─── Guardrails (Non-negotiable) ──────────────────────────────────────────

const GUARDRAILS = {
  // Never reduce approval gates
  minApprovalActions: [
    'send_email', 'send_slack_dm', 'create_commitment',
    'resolve_action', 'draft_email', 'post_to_channel',
  ],
  // Risk tolerance bounds
  minRiskTolerance: 0.1,
  maxRiskTolerance: 0.9,
  // Intervention timing: aggressive can't be learned without explicit user request
  allowedTimingTransitions: {
    conservative: ['moderate'],
    moderate: ['conservative', 'moderate'], // Can't auto-learn to aggressive
    aggressive: ['moderate', 'aggressive'],
  } as Record<string, string[]>,
  // Max change per tuning cycle
  maxRiskToleranceShift: 0.15,
  maxSampleSizeForLearning: 5,       // Minimum interactions before learning
} as const

// ─── Outcome Impact Tracking ──────────────────────────────────────────────

/**
 * Record the impact of an insight/decision on an outcome.
 */
export async function trackOutcomeImpact(
  params: OutcomeImpactParams
): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('outcome_impact')
      .insert({
        org_id: params.orgId,
        outcome_id: params.outcomeId,
        insight_id: params.insightId ?? null,
        decision_card_id: params.decisionCardId ?? null,
        entity_id: params.entityId ?? null,
        impact_type: params.impactType,
        impact_rating: params.impactRating ?? null,
        impact_notes: params.impactNotes ?? null,
        action_taken_at: params.actionTakenAt ?? null,
        outcome_achieved_at: params.outcomeAchievedAt ?? null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[LearningLoop] Failed to track impact:', error.message)
      return null
    }
    return data.id
  } catch (error) {
    console.error('[LearningLoop] Exception tracking impact:', error)
    return null
  }
}

// ─── User Preference Learning ─────────────────────────────────────────────

/**
 * Get or create user preferences.
 */
export async function getUserPreferences(
  orgId: string,
  userId: string
): Promise<UserPreferences> {
  try {
    const supabase = createAdminClient()

    const { data } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single()

    if (data) {
      return {
        interventionTiming: data.intervention_timing as InterventionTiming,
        messageStyle: data.message_style as MessageStyle,
        riskTolerance: data.risk_tolerance as number,
        escalationPreference: data.escalation_preference as EscalationPreference,
        source: data.source as 'default' | 'explicit' | 'learned',
        confidence: data.confidence as number,
        sampleSize: data.sample_size as number,
      }
    }

    // Return defaults if no preferences exist
    return {
      interventionTiming: 'moderate',
      messageStyle: 'brief',
      riskTolerance: 0.5,
      escalationPreference: 'moderate',
      source: 'default',
      confidence: 0.5,
      sampleSize: 0,
    }
  } catch {
    return {
      interventionTiming: 'moderate',
      messageStyle: 'brief',
      riskTolerance: 0.5,
      escalationPreference: 'moderate',
      source: 'default',
      confidence: 0.5,
      sampleSize: 0,
    }
  }
}

/**
 * Update user preferences explicitly (user-set).
 */
export async function setUserPreferences(
  orgId: string,
  userId: string,
  prefs: Partial<Pick<UserPreferences, 'interventionTiming' | 'messageStyle' | 'riskTolerance' | 'escalationPreference'>>
): Promise<boolean> {
  try {
    const supabase = createAdminClient()

    const update: Record<string, unknown> = {
      source: 'explicit',
      confidence: 1.0,
      updated_at: new Date().toISOString(),
    }

    if (prefs.interventionTiming) update.intervention_timing = prefs.interventionTiming
    if (prefs.messageStyle) update.message_style = prefs.messageStyle
    if (prefs.riskTolerance !== undefined) {
      update.risk_tolerance = Math.max(
        GUARDRAILS.minRiskTolerance,
        Math.min(GUARDRAILS.maxRiskTolerance, prefs.riskTolerance)
      )
    }
    if (prefs.escalationPreference) update.escalation_preference = prefs.escalationPreference

    const { error } = await supabase
      .from('user_preferences')
      .upsert({
        org_id: orgId,
        user_id: userId,
        ...update,
      }, { onConflict: 'org_id,user_id' })

    if (error) {
      console.error('[LearningLoop] Failed to set preferences:', error.message)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Learn user preferences from behavior signals.
 * Only applies bounded adjustments with guardrails.
 */
export async function learnUserPreferences(
  orgId: string,
  userId: string
): Promise<TuningProposal[]> {
  const proposals: TuningProposal[] = []

  try {
    const supabase = createAdminClient()

    // Get current preferences
    const current = await getUserPreferences(orgId, userId)

    // Don't override explicit preferences
    if (current.source === 'explicit') return []

    // Gather intervention feedback for the last 30 days
    const { data: feedback } = await supabase
      .from('intervention_feedback')
      .select('user_response, source_category, created_at, response_latency_ms, responded_at')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

    if (!feedback || feedback.length < GUARDRAILS.maxSampleSizeForLearning) return []

    const total = feedback.length
    const accepted = feedback.filter(f => f.user_response === 'accepted').length
    const rejected = feedback.filter(f => f.user_response === 'rejected').length
    const ignored = feedback.filter(f => f.user_response === 'ignored').length
    const acceptanceRate = accepted / total

    // Learn intervention timing
    if (rejected / total > 0.4) {
      // Too many rejections → suggest more conservative
      const allowed = GUARDRAILS.allowedTimingTransitions[current.interventionTiming]
      if (allowed?.includes('conservative')) {
        proposals.push({
          parameter: 'intervention_timing',
          currentValue: current.interventionTiming,
          proposedValue: 'conservative',
          rationale: `${(rejected / total * 100).toFixed(0)}% rejection rate suggests less frequent interventions`,
          evidence: `${rejected}/${total} interventions rejected in 30d`,
          guardrailCheck: 'pass',
        })
      }
    } else if (acceptanceRate > 0.8 && total >= 10) {
      // High acceptance → could be more proactive, but NOT aggressive without explicit ask
      const allowed = GUARDRAILS.allowedTimingTransitions[current.interventionTiming]
      if (allowed?.includes('moderate') && current.interventionTiming === 'conservative') {
        proposals.push({
          parameter: 'intervention_timing',
          currentValue: current.interventionTiming,
          proposedValue: 'moderate',
          rationale: `${(acceptanceRate * 100).toFixed(0)}% acceptance rate — user is receptive`,
          evidence: `${accepted}/${total} interventions accepted in 30d`,
          guardrailCheck: 'pass',
        })
      }
    }

    // Learn risk tolerance (bounded shift)
    if (accepted > rejected && current.riskTolerance < GUARDRAILS.maxRiskTolerance) {
      const shift = Math.min(GUARDRAILS.maxRiskToleranceShift, (acceptanceRate - 0.5) * 0.2)
      if (shift > 0.02) {
        const newTolerance = Math.min(GUARDRAILS.maxRiskTolerance, current.riskTolerance + shift)
        proposals.push({
          parameter: 'risk_tolerance',
          currentValue: current.riskTolerance,
          proposedValue: Math.round(newTolerance * 100) / 100,
          rationale: `High acceptance rate suggests user is comfortable with current risk level`,
          evidence: `Acceptance rate: ${(acceptanceRate * 100).toFixed(0)}%`,
          guardrailCheck: 'pass',
        })
      }
    } else if (rejected > accepted && current.riskTolerance > GUARDRAILS.minRiskTolerance) {
      const shift = Math.min(GUARDRAILS.maxRiskToleranceShift, (0.5 - acceptanceRate) * 0.2)
      if (shift > 0.02) {
        const newTolerance = Math.max(GUARDRAILS.minRiskTolerance, current.riskTolerance - shift)
        proposals.push({
          parameter: 'risk_tolerance',
          currentValue: current.riskTolerance,
          proposedValue: Math.round(newTolerance * 100) / 100,
          rationale: `High rejection rate suggests user wants less risk`,
          evidence: `Rejection rate: ${(rejected / total * 100).toFixed(0)}%`,
          guardrailCheck: 'pass',
        })
      }
    }

    // Learn escalation preference from response latency.
    // Use response_latency_ms if available (recorded at feedback time),
    // otherwise compute from responded_at - created_at timestamps.
    const quickResponses = feedback.filter(f => {
      // Prefer the pre-computed response_latency_ms column
      if (f.response_latency_ms !== undefined && f.response_latency_ms !== null) {
        return (f.response_latency_ms as number) < 15 * 60 * 1000
      }
      // Fallback: compute from responded_at - created_at
      const respondedAt = f.responded_at as string | null
      const createdAt = f.created_at as string | null
      if (!respondedAt || !createdAt) return false
      const latency = new Date(respondedAt).getTime() - new Date(createdAt).getTime()
      return latency > 0 && latency < 15 * 60 * 1000 // Within 15 minutes
    }).length

    if (quickResponses / total > 0.6 && current.escalationPreference !== 'escalate_early') {
      proposals.push({
        parameter: 'escalation_preference',
        currentValue: current.escalationPreference,
        proposedValue: 'escalate_early',
        rationale: `User responds quickly to ${(quickResponses / total * 100).toFixed(0)}% of interventions`,
        evidence: `${quickResponses}/${total} responded within 15min`,
        guardrailCheck: 'pass',
      })
    }

    return proposals
  } catch (error) {
    console.error('[LearningLoop] Failed to learn preferences:', error)
    return proposals
  }
}

// ─── Weekly Tuning ────────────────────────────────────────────────────────

/**
 * Run the weekly tuning cycle for an org.
 * Analyzes the past week's data and proposes bounded adjustments.
 */
export async function runWeeklyTuning(
  orgId: string
): Promise<WeeklyTuningResult | null> {
  try {
    const supabase = createAdminClient()

    const weekStart = getWeekStart()

    // Get metrics from RPC
    const { data: metrics } = await supabase
      .rpc('compute_rollout_metrics', {
        p_org_id: orgId,
        p_week_start: weekStart.toISOString().split('T')[0],
      })

    const m = (metrics as Record<string, unknown>[])?.[0]

    const result: WeeklyTuningResult = {
      weekStart: weekStart.toISOString(),
      totalInteractions: (m?.total_outcomes as number) ?? 0,
      acceptanceRate: (m?.acceptance_rate as number) ?? 0,
      falsePositiveRate: 0,
      proposals: [],
      appliedChanges: [],
      guardrailViolations: [],
    }

    // Gather per-user learning proposals
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id')
      .eq('org_id', orgId)

    for (const profile of profiles ?? []) {
      const userProposals = await learnUserPreferences(orgId, profile.id)

      for (const proposal of userProposals) {
        if (proposal.guardrailCheck === 'pass') {
          result.proposals.push(proposal)
          // Auto-apply learned preferences (bounded by guardrails)
          await applyTuningProposal(orgId, profile.id, proposal)
          result.appliedChanges.push(proposal)
        } else {
          result.guardrailViolations.push(proposal)
        }
      }
    }

    // Log the tuning
    await supabase.from('weekly_tuning_log').insert({
      org_id: orgId,
      tuning_week: weekStart.toISOString().split('T')[0],
      total_interactions: result.totalInteractions,
      acceptance_rate: result.acceptanceRate,
      intervention_accuracy: null,
      false_positive_rate: result.falsePositiveRate,
      proposals: result.proposals as unknown as Json,
      approved_changes: result.appliedChanges as unknown as Json,
      guardrail_violations: result.guardrailViolations as unknown as Json,
      applied_at: new Date().toISOString(),
    })

    console.log(
      `[LearningLoop] Weekly tuning: ${result.proposals.length} proposals, ` +
      `${result.appliedChanges.length} applied, ${result.guardrailViolations.length} blocked`
    )

    return result
  } catch (error) {
    console.error('[LearningLoop] Weekly tuning failed:', error)
    return null
  }
}

async function applyTuningProposal(
  orgId: string,
  userId: string,
  proposal: TuningProposal
): Promise<void> {
  const update: Record<string, unknown> = { source: 'learned', updated_at: new Date().toISOString() }

  switch (proposal.parameter) {
    case 'intervention_timing':
      update.intervention_timing = proposal.proposedValue
      break
    case 'risk_tolerance':
      update.risk_tolerance = proposal.proposedValue
      break
    case 'escalation_preference':
      update.escalation_preference = proposal.proposedValue
      break
    case 'message_style':
      update.message_style = proposal.proposedValue
      break
    default:
      return
  }

  try {
    const supabase = createAdminClient()

    await supabase
      .from('user_preferences')
      .upsert({
        org_id: orgId,
        user_id: userId,
        ...update,
      }, { onConflict: 'org_id,user_id' })
  } catch (error) {
    console.error('[LearningLoop] Failed to apply tuning proposal:', error)
  }
}

function getWeekStart(): Date {
  const now = new Date()
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1)
  const weekStart = new Date(now.setDate(diff))
  weekStart.setHours(0, 0, 0, 0)
  return weekStart
}
