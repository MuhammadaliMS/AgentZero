/**
 * Decision Card — Structured Reasoning Artifacts
 *
 * Phase A of Chief-of-Staff Agent V1 — Reasoning Substrate.
 *
 * DecisionCards capture the agent's reasoning for significant decisions:
 * - What objective was being pursued
 * - What options were considered
 * - What was chosen and why
 * - Confidence level and risk notes
 *
 * Cards are emitted by the agent via the `emit_decision_card` tool
 * during conversation turns, and by background processes (ghost agent,
 * patrol) for proactive signals.
 *
 * All operations are fire-and-forget for the hot path (tool calls).
 * Never throws in production — catches all errors.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export type DecisionCardTriggerType =
  | 'user_turn'
  | 'proactive_signal'
  | 'contradiction'
  | 'planning'
  | 'escalation'
  | 'recovery'

export interface Hypothesis {
  hypothesis: string
  evidence?: string
  confidence?: number
}

export interface OptionConsidered {
  option: string
  pros?: string[]
  cons?: string[]
  rejected_reason?: string
}

export interface DecisionCardParams {
  orgId: string
  conversationId?: string

  triggerType: DecisionCardTriggerType
  triggerSource?: string          // 'chat', 'ghost_agent', 'patrol', 'brief'

  // Core reasoning
  objective: string
  contextSummary?: string
  hypotheses?: Hypothesis[]
  optionsConsidered?: OptionConsidered[]
  chosenAction: string
  confidence: number              // 0-1
  whyNow?: string
  riskNotes?: string

  // Linkage
  relatedEntityIds?: string[]
  relatedInsightIds?: string[]

  // Metadata
  modelUsed?: string
  reasoningTokens?: number
  latencyMs?: number
}

export interface DecisionCard {
  id: string
  orgId: string
  conversationId: string | null
  triggerType: DecisionCardTriggerType
  triggerSource: string | null
  objective: string
  contextSummary: string | null
  hypotheses: Hypothesis[]
  optionsConsidered: OptionConsidered[]
  chosenAction: string
  confidence: number
  whyNow: string | null
  riskNotes: string | null
  relatedEntityIds: string[]
  relatedInsightIds: string[]
  modelUsed: string | null
  reasoningTokens: number | null
  latencyMs: number | null
  createdAt: string
}

// ─── Persistence ──────────────────────────────────────────────────────────

/**
 * Persist a decision card. Fire-and-forget safe.
 * Returns the card ID on success, null on failure.
 */
export async function persistDecisionCard(
  params: DecisionCardParams
): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('decision_cards')
      .insert({
        org_id: params.orgId,
        conversation_id: params.conversationId ?? null,
        trigger_type: params.triggerType,
        trigger_source: params.triggerSource ?? null,
        objective: params.objective,
        context_summary: params.contextSummary ?? null,
        hypotheses: (params.hypotheses ?? []) as unknown as Json,
        options_considered: (params.optionsConsidered ?? []) as unknown as Json,
        chosen_action: params.chosenAction,
        confidence: Math.max(0, Math.min(1, params.confidence)),
        why_now: params.whyNow ?? null,
        risk_notes: params.riskNotes ?? null,
        related_entity_ids: params.relatedEntityIds ?? [],
        related_insight_ids: params.relatedInsightIds ?? [],
        model_used: params.modelUsed ?? null,
        reasoning_tokens: params.reasoningTokens ?? null,
        latency_ms: params.latencyMs ?? null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[DecisionCard] Failed to persist:', error.message)
      return null
    }

    console.log(`[DecisionCard] Persisted card ${data.id} (${params.triggerType}: "${params.objective.slice(0, 60)}")`)
    return data.id
  } catch (error) {
    console.error('[DecisionCard] Exception:', error)
    return null
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────

/**
 * Get decision cards for a conversation.
 */
export async function getDecisionCardsForConversation(
  orgId: string,
  conversationId: string,
  limit = 20
): Promise<DecisionCard[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('decision_cards')
    .select('*')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data.map(mapRowToCard)
}

/**
 * Get recent decision cards for an org.
 */
export async function getRecentDecisionCards(
  orgId: string,
  limit = 20,
  triggerType?: DecisionCardTriggerType
): Promise<DecisionCard[]> {
  const supabase = createAdminClient()

  let query = supabase
    .from('decision_cards')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (triggerType) {
    query = query.eq('trigger_type', triggerType)
  }

  const { data, error } = await query

  if (error || !data) return []

  return data.map(mapRowToCard)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapRowToCard(row: Record<string, unknown>): DecisionCard {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    conversationId: row.conversation_id as string | null,
    triggerType: row.trigger_type as DecisionCardTriggerType,
    triggerSource: row.trigger_source as string | null,
    objective: row.objective as string,
    contextSummary: row.context_summary as string | null,
    hypotheses: (row.hypotheses ?? []) as Hypothesis[],
    optionsConsidered: (row.options_considered ?? []) as OptionConsidered[],
    chosenAction: row.chosen_action as string,
    confidence: row.confidence as number,
    whyNow: row.why_now as string | null,
    riskNotes: row.risk_notes as string | null,
    relatedEntityIds: (row.related_entity_ids ?? []) as string[],
    relatedInsightIds: (row.related_insight_ids ?? []) as string[],
    modelUsed: row.model_used as string | null,
    reasoningTokens: row.reasoning_tokens as number | null,
    latencyMs: row.latency_ms as number | null,
    createdAt: row.created_at as string,
  }
}
