/**
 * Utility Tracker — Five-Stage Memory Utility Funnel
 *
 * Tracks how entities and memories move through the utility pipeline:
 *   retrieved (0.05) → injected (0.10) → cited (0.30) → accepted (0.70) → acted (1.00)
 *
 * Used to compute per-entity utility_score which:
 *   - Boosts relevance in associative recall
 *   - Protects high-utility entities from decay
 *   - Informs insight action routing confidence
 *
 * All operations are fire-and-forget. Never throws.
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ────────────────────────────────────────────────────────────────

export type UtilityEventType = 'retrieved' | 'injected' | 'cited' | 'accepted' | 'acted'

export interface TrackUtilityParams {
  entityId?: string
  memoryId?: string
  insightId?: string
  eventType: UtilityEventType
  conversationId?: string
  sourceChannel?: string // 'chat' | 'brief' | 'nudge'
}

// ─── Constants ────────────────────────────────────────────────────────────

const STAGE_WEIGHTS: Record<UtilityEventType, number> = {
  retrieved: 0.05,
  injected: 0.10,
  cited: 0.30,
  accepted: 0.70,
  acted: 1.00,
}

// Decay constant for utility events (30-day half-life)
const UTILITY_DECAY_LAMBDA = 0.0231

// Max utility score to prevent runaway
const MAX_UTILITY_SCORE = 2.0

// ─── Event Recording ─────────────────────────────────────────────────────

/**
 * Record a utility event. Fire-and-forget.
 * Never throws — catches all errors.
 */
export async function trackUtilityEvent(
  orgId: string,
  params: TrackUtilityParams
): Promise<void> {
  try {
    const supabase = createAdminClient()

    await supabase.from('memory_utility_events').insert({
      org_id: orgId,
      entity_id: params.entityId ?? null,
      memory_id: params.memoryId ?? null,
      insight_id: params.insightId ?? null,
      event_type: params.eventType,
      conversation_id: params.conversationId ?? null,
      source_channel: params.sourceChannel ?? null,
    })
  } catch (error) {
    console.error('[UtilityTracker] Failed to track event:', error)
  }
}

/**
 * Track utility events for multiple entities at once (batch).
 * Fire-and-forget. Never throws.
 */
export async function trackUtilityEventBatch(
  orgId: string,
  entityIds: string[],
  eventType: UtilityEventType,
  conversationId?: string,
  sourceChannel?: string
): Promise<void> {
  if (entityIds.length === 0) return

  try {
    const supabase = createAdminClient()

    const rows = entityIds.map(entityId => ({
      org_id: orgId,
      entity_id: entityId,
      memory_id: null,
      insight_id: null,
      event_type: eventType,
      conversation_id: conversationId ?? null,
      source_channel: sourceChannel ?? null,
    }))

    await supabase.from('memory_utility_events').insert(rows)
  } catch (error) {
    console.error('[UtilityTracker] Failed to track batch:', error)
  }
}

// ─── Access Bumping ──────────────────────────────────────────────────────

/**
 * Bump access count + timestamp for entities.
 * Fire-and-forget. Never throws.
 */
export async function bumpEntityAccess(
  orgId: string,
  entityIds: string[]
): Promise<void> {
  if (entityIds.length === 0) return

  try {
    const supabase = createAdminClient()

    await supabase.rpc('bump_entity_access', {
      p_org_id: orgId,
      p_entity_ids: entityIds,
    })
  } catch (error) {
    console.error('[UtilityTracker] Failed to bump access:', error)
  }
}

// ─── Utility Score Recomputation ─────────────────────────────────────────

/**
 * Recompute utility scores for all entities in an org.
 *
 * Formula: utility_score = Σ(weight × exp(-λ × days))
 * Saturation cap: min(computed, MAX_UTILITY_SCORE)
 *
 * Returns the number of entities updated.
 */
export async function recomputeUtilityScores(
  orgId: string
): Promise<number> {
  const supabase = createAdminClient()

  // Get all utility events for this org, grouped by entity
  const { data: events } = await supabase
    .from('memory_utility_events')
    .select('entity_id, event_type, created_at')
    .eq('org_id', orgId)
    .not('entity_id', 'is', null)

  if (!events || events.length === 0) return 0

  // Group by entity_id
  const entityScores = new Map<string, number>()

  for (const event of events) {
    if (!event.entity_id) continue

    const weight = STAGE_WEIGHTS[event.event_type as UtilityEventType] ?? 0
    const daysOld = (Date.now() - new Date(event.created_at).getTime()) / 86_400_000
    const decayedWeight = weight * Math.exp(-UTILITY_DECAY_LAMBDA * daysOld)

    const current = entityScores.get(event.entity_id) ?? 0
    entityScores.set(event.entity_id, current + decayedWeight)
  }

  // Batch update entities — collect all updates, then execute in chunks
  const updates = Array.from(entityScores.entries()).map(([entityId, rawScore]) => ({
    entityId,
    score: Math.round(Math.min(rawScore, MAX_UTILITY_SCORE) * 1000) / 1000,
  }))

  let updated = 0
  const BATCH_SIZE = 50
  const now = new Date().toISOString()

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE)

    // Use Promise.all for concurrent updates within each batch
    const results = await Promise.all(
      batch.map(({ entityId, score }) =>
        supabase
          .from('entities')
          .update({ utility_score: score, updated_at: now })
          .eq('id', entityId)
          .eq('org_id', orgId)
      )
    )

    updated += results.filter(r => !r.error).length
  }

  return updated
}

// ─── Exports for stage weights (used by tests) ──────────────────────────

export { STAGE_WEIGHTS, MAX_UTILITY_SCORE }
