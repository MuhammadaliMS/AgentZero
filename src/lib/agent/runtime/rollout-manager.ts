/**
 * Rollout Manager — Phase F of Chief-of-Staff Agent V1.
 *
 * Controls the progressive autonomy expansion:
 *   shadow   → Decision cards only, no actions taken
 *   assisted → Low-risk auto, medium/high needs approval
 *   auto     → Internal low-risk auto, external needs approval
 *
 * Expansion criteria: acceptance_rate ≥ 80%, error_rate ≤ 5%,
 * min 40 interactions before mode change.
 *
 * All operations are fire-and-forget safe.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export type RolloutMode = 'shadow' | 'assisted' | 'auto'

export interface RolloutConfig {
  orgId: string
  rolloutMode: RolloutMode
  minAcceptanceRate: number
  maxErrorRate: number
  minInteractions: number
  autoAllowedActions: string[]
  modeChangedAt: string | null
  modeChangedReason: string | null
  previousMode: string | null
  manualAutoApproved: boolean
}

export interface RolloutMeasurement {
  measurementWeek: string
  totalOutcomes: number
  completedOutcomes: number
  failedOutcomes: number
  totalDecisions: number
  avgDecisionConfidence: number | null
  acceptanceRate: number | null
  errorRate: number | null
  outcomeImpactScore: number | null
  recommendedMode: RolloutMode | null
  recommendationReason: string | null
}

// ─── Default allowed actions per mode ─────────────────────────────────────

const DEFAULT_AUTO_ACTIONS = [
  'recall_memory', 'store_memory', 'query_entity_graph',
  'get_entity_timeline', 'emit_decision_card',
  'query_commitments', 'query_actions',
  'read_recent_emails', 'search_emails', 'read_email',
  'list_slack_channels', 'read_slack_channel',
  'get_today_events', 'get_week_events', 'find_free_slots',
  'get_compliance_overview', 'list_failing_controls', 'get_audit_status',
  'list_connected_integrations', 'get_integration_health',
  // Outcome control plane — these are internal orchestration tools,
  // not external actions. They must always be allowed so the agent
  // can manage its own task tracking in any rollout mode.
  'create_outcome', 'update_outcome', 'list_outcomes',
]

// In shadow mode, these are the ONLY actions that can execute
const SHADOW_ACTIONS = [
  'recall_memory', 'store_memory', 'query_entity_graph',
  'get_entity_timeline', 'emit_decision_card',
  // Outcome control plane — even in shadow mode, the agent must be
  // able to create/manage outcomes to build a track record.
  'create_outcome', 'update_outcome', 'list_outcomes',
]

// ─── Config Management ────────────────────────────────────────────────────

/**
 * Get or create rollout config for an org.
 */
export async function getRolloutConfig(orgId: string): Promise<RolloutConfig> {
  try {
    const supabase = createAdminClient()

    const { data } = await supabase
      .from('org_rollout_config')
      .select('*')
      .eq('org_id', orgId)
      .single()

    if (data) {
      return {
        orgId: data.org_id as string,
        rolloutMode: data.rollout_mode as RolloutMode,
        minAcceptanceRate: data.min_acceptance_rate as number,
        maxErrorRate: data.max_error_rate as number,
        minInteractions: data.min_interactions as number,
        autoAllowedActions: (data.auto_allowed_actions ?? DEFAULT_AUTO_ACTIONS) as string[],
        modeChangedAt: data.mode_changed_at as string | null,
        modeChangedReason: data.mode_changed_reason as string | null,
        previousMode: data.previous_mode as string | null,
        manualAutoApproved: (data.manual_auto_approved as boolean) ?? false,
      }
    }

    // Create default config — start in 'assisted' mode (not 'shadow').
    // Shadow mode blocks all tools except memory, creating a deadlock where
    // the agent can never earn trust to advance. Assisted mode lets the agent
    // read and act, with external actions requiring approval.
    const { data: newConfig } = await supabase
      .from('org_rollout_config')
      .insert({
        org_id: orgId,
        rollout_mode: 'assisted' as const,
        min_interactions: 20,
        auto_allowed_actions: DEFAULT_AUTO_ACTIONS,
      })
      .select('*')
      .single()

    if (!newConfig) {
      return {
        orgId,
        rolloutMode: 'assisted',
        minAcceptanceRate: 0.80,
        maxErrorRate: 0.05,
        minInteractions: 20,
        autoAllowedActions: DEFAULT_AUTO_ACTIONS,
        modeChangedAt: null,
        modeChangedReason: null,
        previousMode: null,
        manualAutoApproved: false,
      }
    }

    return {
      orgId: newConfig.org_id as string,
      rolloutMode: newConfig.rollout_mode as RolloutMode,
      minAcceptanceRate: newConfig.min_acceptance_rate as number,
      maxErrorRate: newConfig.max_error_rate as number,
      minInteractions: newConfig.min_interactions as number,
      autoAllowedActions: (newConfig.auto_allowed_actions ?? DEFAULT_AUTO_ACTIONS) as string[],
      modeChangedAt: newConfig.mode_changed_at as string | null,
      modeChangedReason: newConfig.mode_changed_reason as string | null,
      previousMode: newConfig.previous_mode as string | null,
      manualAutoApproved: (newConfig.manual_auto_approved as boolean) ?? false,
    }
  } catch {
    return {
      orgId,
      rolloutMode: 'assisted',
      minAcceptanceRate: 0.80,
      maxErrorRate: 0.05,
      minInteractions: 20,
      autoAllowedActions: DEFAULT_AUTO_ACTIONS,
      modeChangedAt: null,
      modeChangedReason: null,
      previousMode: null,
      manualAutoApproved: false,
    }
  }
}

/**
 * Check if an action is allowed in the current rollout mode.
 */
export function isActionAllowed(
  config: RolloutConfig,
  toolName: string
): { allowed: boolean; requiresApproval: boolean; reason?: string } {
  switch (config.rolloutMode) {
    case 'shadow':
      // Only memory + reasoning tools allowed
      if (SHADOW_ACTIONS.includes(toolName)) {
        return { allowed: true, requiresApproval: false }
      }
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Shadow mode: "${toolName}" produces a decision card but does not execute`,
      }

    case 'assisted':
      // All read tools auto, write tools need approval
      if (config.autoAllowedActions.includes(toolName)) {
        return { allowed: true, requiresApproval: false }
      }
      return { allowed: true, requiresApproval: true }

    case 'auto':
      // Auto-allowed actions execute freely, external actions need approval
      if (config.autoAllowedActions.includes(toolName)) {
        return { allowed: true, requiresApproval: false }
      }
      // External/destructive always need approval
      return { allowed: true, requiresApproval: true }

    default:
      return { allowed: false, requiresApproval: false, reason: 'Unknown rollout mode' }
  }
}

/**
 * Advance or revert rollout mode based on metrics.
 */
export async function evaluateRolloutAdvancement(
  orgId: string
): Promise<{ newMode: RolloutMode | null; reason: string }> {
  try {
    const config = await getRolloutConfig(orgId)
    const supabase = createAdminClient()

    // Get the last 4 weeks of measurements
    const { data: measurements } = await supabase
      .from('rollout_measurement')
      .select('*')
      .eq('org_id', orgId)
      .order('measurement_week', { ascending: false })
      .limit(4)

    if (!measurements || measurements.length < 2) {
      return { newMode: null, reason: 'Not enough measurement data (need ≥2 weeks)' }
    }

    // ── Phase 3a Safety Guard: Latest-week error rate auto-revert ────────
    const latestMeasurement = measurements[0] // already ordered desc
    const latestError = (latestMeasurement.error_rate as number) ?? 0

    if (latestError > 0.10) {
      const previousMode = getPreviousMode(config.rolloutMode)
      if (previousMode !== config.rolloutMode) {
        await updateRolloutMode(orgId, previousMode, config.rolloutMode,
          `SAFETY REVERT: latest week error_rate=${(latestError * 100).toFixed(1)}% exceeds 10% threshold`)
        return {
          newMode: previousMode,
          reason: `Latest week error rate ${(latestError * 100).toFixed(1)}% > 10% — immediate safety revert to ${previousMode}`,
        }
      }
    }

    // Aggregate metrics
    const totalInteractions = measurements.reduce(
      (sum, m) => sum + ((m.total_outcomes as number) ?? 0), 0
    )

    if (totalInteractions < config.minInteractions) {
      return {
        newMode: null,
        reason: `Only ${totalInteractions}/${config.minInteractions} interactions — need more data`,
      }
    }

    const avgAcceptance = measurements.reduce(
      (sum, m) => sum + ((m.acceptance_rate as number) ?? 0), 0
    ) / measurements.length

    const avgError = measurements.reduce(
      (sum, m) => sum + ((m.error_rate as number) ?? 0), 0
    ) / measurements.length

    // Advancement check
    const canAdvance = avgAcceptance >= config.minAcceptanceRate && avgError <= config.maxErrorRate
    const shouldRevert = avgAcceptance < 0.5 || avgError > 0.1

    if (shouldRevert) {
      // Revert
      const previousMode = getPreviousMode(config.rolloutMode)
      if (previousMode !== config.rolloutMode) {
        await updateRolloutMode(orgId, previousMode, config.rolloutMode,
          `Reverting: acceptance=${(avgAcceptance * 100).toFixed(0)}%, error=${(avgError * 100).toFixed(0)}%`)
        return {
          newMode: previousMode,
          reason: `Metrics below threshold — reverting to ${previousMode}`,
        }
      }
    }

    if (canAdvance) {
      const nextMode = getNextMode(config.rolloutMode)
      if (nextMode !== config.rolloutMode) {
        // ── Phase 3a Safety Guard: Manual gate for auto advancement ──────
        if (nextMode === 'auto' && !config.manualAutoApproved) {
          return {
            newMode: null,
            reason: 'Advancement to auto requires explicit admin approval via API or chat command',
          }
        }

        await updateRolloutMode(orgId, nextMode, config.rolloutMode,
          `Advancing: acceptance=${(avgAcceptance * 100).toFixed(0)}%, error=${(avgError * 100).toFixed(0)}%`)
        return {
          newMode: nextMode,
          reason: `Metrics meet criteria — advancing to ${nextMode}`,
        }
      }
    }

    return {
      newMode: null,
      reason: `Staying in ${config.rolloutMode}: acceptance=${(avgAcceptance * 100).toFixed(0)}%, error=${(avgError * 100).toFixed(0)}%`,
    }
  } catch (error) {
    console.error('[RolloutManager] Evaluation failed:', error)
    return { newMode: null, reason: 'Evaluation error' }
  }
}

/**
 * Explicitly set the rollout mode for an org.
 * Used by admin API or chat commands to manually control autonomy level.
 */
export async function setRolloutMode(
  orgId: string,
  newMode: RolloutMode,
  reason: string
): Promise<{ success: boolean; previousMode: RolloutMode; reason: string }> {
  try {
    const config = await getRolloutConfig(orgId)
    const previousMode = config.rolloutMode

    await updateRolloutMode(orgId, newMode, previousMode, reason)

    // If setting to 'auto', also set the manual approval flag
    if (newMode === 'auto') {
      const supabase = createAdminClient()
      await supabase
        .from('org_rollout_config')
        .update({
          manual_auto_approved: true,
          updated_at: new Date().toISOString(),
        })
        .eq('org_id', orgId)
    }

    return { success: true, previousMode, reason }
  } catch (error) {
    console.error('[RolloutManager] setRolloutMode failed:', error)
    return {
      success: false,
      previousMode: 'assisted' as RolloutMode,
      reason: `Failed to set mode: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}

/**
 * Record weekly measurement snapshot.
 */
export async function recordWeeklyMeasurement(
  orgId: string
): Promise<RolloutMeasurement | null> {
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
    if (!m) return null

    // Get impact score
    const { data: impacts } = await supabase
      .from('outcome_impact')
      .select('impact_rating')
      .eq('org_id', orgId)
      .gte('created_at', weekStart.toISOString())
      .not('impact_rating', 'is', null)

    const avgImpact = impacts && impacts.length > 0
      ? impacts.reduce((sum, i) => sum + ((i.impact_rating as number) ?? 0), 0) / impacts.length
      : null

    // Get intervention stats
    const { data: interventions } = await supabase
      .from('intervention_feedback')
      .select('user_response')
      .eq('org_id', orgId)
      .gte('created_at', weekStart.toISOString())

    const intAccepted = interventions?.filter(i => i.user_response === 'accepted').length ?? 0
    const intIgnored = interventions?.filter(i => i.user_response === 'ignored').length ?? 0
    const intRejected = interventions?.filter(i => i.user_response === 'rejected').length ?? 0

    // ── Phase 3b: Query outcome metrics directly ──────────────────────
    const { data: weekOutcomes } = await supabase
      .from('outcomes')
      .select('status')
      .eq('org_id', orgId)
      .gte('updated_at', weekStart.toISOString())

    const outcomeCompleted = weekOutcomes?.filter(o => o.status === 'completed').length ?? 0
    const outcomeFailed = weekOutcomes?.filter(o => o.status === 'failed').length ?? 0
    const outcomeTotal = weekOutcomes?.length ?? 0

    const config = await getRolloutConfig(orgId)
    const acceptanceRate = (m.acceptance_rate as number) ?? null
    const errorRate = (m.error_rate as number) ?? null

    // Recommend mode
    let recommendedMode: RolloutMode | null = null
    let recommendationReason: string | null = null

    if (acceptanceRate !== null && errorRate !== null) {
      if (acceptanceRate < 0.5 || errorRate > 0.1) {
        recommendedMode = getPreviousMode(config.rolloutMode)
        recommendationReason = 'Metrics below threshold — consider reverting'
      } else if (acceptanceRate >= config.minAcceptanceRate && errorRate <= config.maxErrorRate) {
        const next = getNextMode(config.rolloutMode)
        if (next !== config.rolloutMode) {
          recommendedMode = next
          recommendationReason = 'Metrics meet advancement criteria'
        }
      }
    }

    // Use direct outcome query values, falling back to RPC values if needed
    const finalTotalOutcomes = outcomeTotal > 0 ? outcomeTotal : ((m.total_outcomes as number) ?? 0)
    const finalCompletedOutcomes = outcomeTotal > 0 ? outcomeCompleted : ((m.completed_outcomes as number) ?? 0)
    const finalFailedOutcomes = outcomeTotal > 0 ? outcomeFailed : ((m.failed_outcomes as number) ?? 0)

    const measurement = {
      org_id: orgId,
      measurement_week: weekStart.toISOString().split('T')[0],
      total_outcomes: finalTotalOutcomes,
      completed_outcomes: finalCompletedOutcomes,
      failed_outcomes: finalFailedOutcomes,
      total_decisions: (m.total_decisions as number) ?? 0,
      avg_decision_confidence: (m.avg_confidence as number) ?? null,
      acceptance_rate: acceptanceRate,
      error_rate: errorRate,
      outcome_impact_score: avgImpact,
      interventions_accepted: intAccepted,
      interventions_ignored: intIgnored,
      interventions_rejected: intRejected,
      recommended_mode: recommendedMode,
      recommendation_reason: recommendationReason,
    }

    await supabase.from('rollout_measurement').insert(measurement)

    return {
      measurementWeek: weekStart.toISOString().split('T')[0],
      totalOutcomes: finalTotalOutcomes,
      completedOutcomes: finalCompletedOutcomes,
      failedOutcomes: finalFailedOutcomes,
      totalDecisions: (m.total_decisions as number) ?? 0,
      avgDecisionConfidence: (m.avg_confidence as number) ?? null,
      acceptanceRate,
      errorRate,
      outcomeImpactScore: avgImpact,
      recommendedMode,
      recommendationReason,
    }
  } catch (error) {
    console.error('[RolloutManager] Failed to record measurement:', error)
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getNextMode(current: RolloutMode): RolloutMode {
  switch (current) {
    case 'shadow': return 'assisted'
    case 'assisted': return 'auto'
    case 'auto': return 'auto'
  }
}

function getPreviousMode(current: RolloutMode): RolloutMode {
  switch (current) {
    case 'auto': return 'assisted'
    case 'assisted': return 'shadow'
    case 'shadow': return 'shadow'
  }
}

async function updateRolloutMode(
  orgId: string,
  newMode: RolloutMode,
  previousMode: RolloutMode,
  reason: string
): Promise<void> {
  try {
    const supabase = createAdminClient()

    await supabase
      .from('org_rollout_config')
      .update({
        rollout_mode: newMode,
        previous_mode: previousMode,
        mode_changed_at: new Date().toISOString(),
        mode_changed_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)

    console.log(`[RolloutManager] Mode change: ${previousMode} → ${newMode} (${reason})`)

    // Structured event for observability (consumed by log aggregation + future SSE)
    console.log(JSON.stringify({
      event: 'rollout_mode_changed',
      orgId,
      rolloutMode: newMode,
      rolloutReason: reason,
      previousMode,
      timestamp: new Date().toISOString(),
    }))
  } catch (error) {
    console.error('[RolloutManager] Failed to update mode:', error)
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
