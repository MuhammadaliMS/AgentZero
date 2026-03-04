/**
 * Insight Action Router — Three-Tier Execution Policy
 *
 * Routes graph insights to patrol findings based on confidence levels:
 *   ≥ 0.80  → auto-execute (internal low-risk only, requires evidence threshold)
 *   0.60–0.79 → recommend with ask
 *   < 0.60  → surface in briefs only (clarify)
 *
 * Hard rule: External/destructive actions ALWAYS require approval.
 *
 * Evidence threshold: An insight must have times_triggered ≥ 2 AND
 * at least 1 successful prior outcome before auto-exec activates.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json, Database } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export interface RoutingResult {
  routed: number
  autoExecuted: number
  recommended: number
  skipped: number
}

interface InsightRow {
  id: string
  org_id: string
  insight_type: string
  category: string | null
  summary: string
  confidence: number
  related_entity_ids: string[]
  action_template: Record<string, unknown> | null
  times_triggered: number
}

// ─── Constants ────────────────────────────────────────────────────────────

const EXECUTION_POLICY = {
  autoExecThreshold: 0.80,
  recommendThreshold: 0.60,
  minTriggersForAuto: 2,
  minSuccessfulOutcomes: 1,
  alwaysApproval: new Set([
    'external_communication',
    'commitment_creation',
    'destructive_action',
  ]),
} as const

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Route eligible active insights to patrol findings.
 * Called by ghost agent (both hourly and daily).
 */
export async function routeInsightsToActions(
  orgId: string
): Promise<RoutingResult> {
  const result: RoutingResult = {
    routed: 0,
    autoExecuted: 0,
    recommended: 0,
    skipped: 0,
  }

  const supabase = createAdminClient()

  // Get unrouted active insights
  const { data: insights } = await supabase
    .from('graph_insights')
    .select('id, org_id, insight_type, category, summary, confidence, related_entity_ids, action_template, times_triggered')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .is('routed_finding_id', null)
    .order('confidence', { ascending: false })
    .limit(20)

  if (!insights || insights.length === 0) return result

  for (const insight of insights as InsightRow[]) {
    try {
      // Skip insights without action templates
      if (!insight.action_template) {
        result.skipped++
        continue
      }

      // Determine decision mode
      const decisionMode = await determineDecisionMode(supabase, orgId, insight)

      if (decisionMode === 'clarify') {
        result.skipped++
        continue // Don't route — surface in briefs only
      }

      // Map insight type to finding type
      const findingType = mapInsightToFindingType(insight) as Database['public']['Tables']['patrol_findings']['Insert']['type']
      const severity = mapConfidenceToSeverity(insight.confidence)

      // Create patrol finding
      const { data: finding } = await supabase
        .from('patrol_findings')
        .insert({
          org_id: orgId,
          type: findingType,
          title: insight.summary.slice(0, 200),
          description: buildFindingDescription(insight, decisionMode),
          severity,
          status: 'open' as const,
          entity_id: insight.related_entity_ids?.[0] ?? null,
          metadata: {
            source: 'graph_insight',
            insight_id: insight.id,
            insight_type: insight.insight_type,
            decision_mode: decisionMode,
            action_template: insight.action_template,
          } as unknown as Json,
        })
        .select('id')
        .single()

      if (!finding) {
        result.skipped++
        continue
      }

      // Record in insight_actions
      await supabase.from('insight_actions').insert({
        org_id: orgId,
        insight_id: insight.id,
        finding_id: finding.id,
        action_id: null,
        decision_mode: decisionMode,
        policy_path: `${insight.insight_type}.${insight.category ?? 'general'}.${decisionMode}`,
        execution_result: decisionMode === 'auto' ? 'executed' : 'pending',
      })

      // Update insight: mark as routed
      await supabase
        .from('graph_insights')
        .update({
          routed_finding_id: finding.id,
          status: 'routed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', insight.id)

      result.routed++
      if (decisionMode === 'auto') {
        result.autoExecuted++
      } else {
        result.recommended++
      }
    } catch (error) {
      console.error(`[InsightRouter] Error routing insight ${insight.id}:`, error)
      result.skipped++
    }
  }

  return result
}

// ─── Decision Mode ───────────────────────────────────────────────────────

async function determineDecisionMode(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  insight: InsightRow
): Promise<'auto' | 'recommended' | 'clarify'> {
  // Below recommend threshold → clarify only
  if (insight.confidence < EXECUTION_POLICY.recommendThreshold) {
    return 'clarify'
  }

  // Between recommend and auto → recommended
  if (insight.confidence < EXECUTION_POLICY.autoExecThreshold) {
    return 'recommended'
  }

  // Above auto threshold — but check evidence requirements
  const actionType = (insight.action_template as Record<string, unknown>)?.type as string | undefined

  // Always require approval for dangerous actions
  if (actionType && EXECUTION_POLICY.alwaysApproval.has(actionType)) {
    return 'recommended'
  }

  // Must have minimum triggers
  if (insight.times_triggered < EXECUTION_POLICY.minTriggersForAuto) {
    return 'recommended'
  }

  // Must have at least 1 successful prior outcome
  const { count } = await supabase
    .from('insight_actions')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('insight_id', insight.id)
    .in('execution_result', ['executed', 'approved'])

  if ((count ?? 0) < EXECUTION_POLICY.minSuccessfulOutcomes) {
    return 'recommended'
  }

  return 'auto'
}

// ─── Feedback Backflow ───────────────────────────────────────────────────

/**
 * Handle feedback when a routed finding is resolved.
 * Updates insight_actions and bumps utility scores.
 */
export async function handleFindingResolved(
  orgId: string,
  findingId: string,
  outcome: 'approved' | 'rejected'
): Promise<void> {
  const supabase = createAdminClient()

  // Find the insight_action for this finding
  const { data: action } = await supabase
    .from('insight_actions')
    .select('id, insight_id')
    .eq('org_id', orgId)
    .eq('finding_id', findingId)
    .limit(1)
    .maybeSingle()

  if (!action) return

  // Update execution result
  await supabase
    .from('insight_actions')
    .update({
      execution_result: outcome,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', action.id)

  // If approved, bump the insight's utility
  if (outcome === 'approved' && action.insight_id) {
    const { data: insight } = await supabase
      .from('graph_insights')
      .select('related_entity_ids')
      .eq('id', action.insight_id)
      .single()

    if (insight?.related_entity_ids) {
      // Fire utility events for involved entities
      const { trackUtilityEventBatch } = await import('./utility-tracker')
      await trackUtilityEventBatch(orgId, insight.related_entity_ids, 'acted')
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapInsightToFindingType(insight: InsightRow): string {
  switch (insight.insight_type) {
    case 'contradiction':
      return 'unresolved_blocker'
    case 'risk':
      return 'at_risk_commitment'
    case 'anomaly':
      return 'anomaly_detected'
    case 'stale':
      return 'stale_entity'
    case 'pattern':
      return 'recurring_pattern'
    case 'opportunity':
      return 'opportunity_identified'
    case 'correlation':
      return 'recurring_pattern'
    case 'compression':
      return 'recurring_pattern'
    default:
      return 'stale_entity'
  }
}

function mapConfidenceToSeverity(confidence: number): 'critical' | 'high' | 'medium' | 'low' {
  if (confidence >= 0.9) return 'critical'
  if (confidence >= 0.7) return 'high'
  if (confidence >= 0.5) return 'medium'
  return 'low'
}

function buildFindingDescription(insight: InsightRow, decisionMode: string): string {
  const modeLabel = decisionMode === 'auto' ? '🤖 Auto-executed' :
                    decisionMode === 'recommended' ? '💡 Recommended' : '❓ Needs investigation'

  const template = insight.action_template as Record<string, unknown> | null
  const suggestedAction = template?.suggested_action as string | undefined

  let desc = `[${modeLabel}] ${insight.summary}`
  if (suggestedAction) {
    desc += `\n\nSuggested action: ${suggestedAction}`
  }
  desc += `\n\nSource: ${insight.insight_type} insight (confidence: ${insight.confidence.toFixed(2)}, triggers: ${insight.times_triggered})`

  return desc
}
