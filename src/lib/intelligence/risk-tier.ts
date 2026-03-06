/**
 * Risk Tier Engine — Routes chief loop decisions through tiered approval gates.
 *
 * Three tiers:
 *   AUTO    (risk < 0.3): Execute immediately, no notification
 *   NOTIFY  (0.3-0.7):   Execute immediately, send post-execution notification
 *   APPROVAL (risk > 0.7): Block, require explicit user approval
 *
 * Safety: EXTERNAL_TOOLS always floor at 0.7 regardless of LLM-assigned score.
 */

import type { ChiefDecision } from '@/lib/agent/openai/chief-analyst-agent'
import { EXTERNAL_TOOLS } from '@/lib/agent/planner/plan-validator'

export type RiskTier = 'auto' | 'notify' | 'approval'

const RISK_THRESHOLDS = {
  auto_max: 0.3,
  notify_max: 0.7,
} as const

/**
 * Infer a base risk score from the decision type when the LLM didn't assign one.
 * Conservative defaults — real scores should come from the LLM.
 */
export function inferRiskScore(decision: ChiefDecision): number {
  switch (decision.type) {
    case 'dismiss':
    case 'defer':
    case 'attach_signal':
      return 0.1
    case 'store_insight':
    case 'store_memory':
      return 0.15
    case 'create_entity':
    case 'update_entity':
    case 'create_relationship':
      return 0.2
    case 'skip_step':
    case 'block_step':
      return 0.3
    case 'execute_step':
      return 0.4 // May be overridden by step's own risk
    case 'create_outcome':
    case 'branch_replan':
      return 0.5
    case 'escalate_blocker':
      return 0.6
    default:
      return 0.5
  }
}

/**
 * Compute effective risk score with safety floors for external tools.
 * Uses LLM-assigned score when available, falls back to type-based inference.
 */
export function computeEffectiveRisk(
  decision: ChiefDecision,
  options?: { stepToolName?: string; stepRiskClass?: string }
): number {
  // Start with LLM-assigned score or infer from type
  let score = decision.riskScore ?? inferRiskScore(decision)

  // Safety floor: external tools always >= 0.7
  if (options?.stepToolName && EXTERNAL_TOOLS.includes(options.stepToolName)) {
    score = Math.max(score, 0.7)
  }
  if (options?.stepRiskClass === 'external') {
    score = Math.max(score, 0.7)
  }

  return Math.min(1.0, Math.max(0.0, score))
}

/** Map a risk score to its approval tier */
export function getRiskTier(score: number): RiskTier {
  if (score < RISK_THRESHOLDS.auto_max) return 'auto'
  if (score < RISK_THRESHOLDS.notify_max) return 'notify'
  return 'approval'
}
