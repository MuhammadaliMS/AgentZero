/**
 * Ghost Agent — Dual-Cadence Background Intelligence
 *
 * Hourly light pass:
 *   1. Expire stale insights
 *   2. Velocity spike detection → anomaly insights
 *   3. Route eligible insights to actions
 *
 * Daily deep pass:
 *   1. Everything in light pass, plus:
 *   2. Co-occurrence analysis → pattern insights
 *   3. Orphaned entity detection → stale insights
 *   4. Stale high-value entity detection → stale insights
 *   5. Recompute utility scores
 *   6. Run decay cycle
 *   7. Run compression engine
 *
 * All pure SQL — zero LLM calls.
 * All insights use upsert_insight_with_dedupe for idempotency.
 * Never throws — catches per-step errors and continues.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { routeInsightsToActions, type RoutingResult } from '@/lib/graph/insight-action-router'
import { recomputeUtilityScores } from '@/lib/graph/utility-tracker'
import { runCompression, type CompressionResult } from '@/lib/graph/compression-engine'

// ─── Types ────────────────────────────────────────────────────────────────

export interface GhostAgentLightResult {
  expired: number
  velocitySpikes: number
  routing: RoutingResult
  durationMs: number
}

export interface GhostAgentDeepResult extends GhostAgentLightResult {
  coOccurrencePatterns: number
  orphanedEntities: number
  staleEntities: number
  utilityUpdated: number
  decayCycles: number
  compression: CompressionResult
}

// ─── Light Pass (Hourly) ─────────────────────────────────────────────────

/**
 * Hourly light pass: expire, detect velocity spikes, route insights.
 */
export async function runGhostAgentLight(
  orgId: string
): Promise<GhostAgentLightResult> {
  const startTime = Date.now()
  const supabase = createAdminClient()

  let expired = 0
  let velocitySpikes = 0
  let routing: RoutingResult = { routed: 0, autoExecuted: 0, recommended: 0, skipped: 0 }

  // 1a. Expire stale active insights
  try {
    const { data: expiredRows } = await supabase
      .from('graph_insights')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString())
      .select('id')

    expired = expiredRows?.length ?? 0
  } catch (error) {
    console.error('[GhostAgent:light] Expire active error:', error)
  }

  // 1b. Unstick stale routed insights — routed for 14+ days with no resolution
  // Sets them back to 'active' so they can be re-routed or expire normally
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const { data: unstuckRows } = await supabase
      .from('graph_insights')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('status', 'routed')
      .lt('updated_at', fourteenDaysAgo)
      .select('id')

    expired += unstuckRows?.length ?? 0
  } catch (error) {
    console.error('[GhostAgent:light] Unstick routed error:', error)
  }

  // 2. Velocity spike detection
  try {
    velocitySpikes = await detectVelocitySpikes(supabase, orgId)
  } catch (error) {
    console.error('[GhostAgent:light] Velocity spike error:', error)
  }

  // 3. Route eligible insights
  try {
    routing = await routeInsightsToActions(orgId)
  } catch (error) {
    console.error('[GhostAgent:light] Routing error:', error)
  }

  return {
    expired,
    velocitySpikes,
    routing,
    durationMs: Date.now() - startTime,
  }
}

// ─── Deep Pass (Daily) ───────────────────────────────────────────────────

/**
 * Daily deep pass: everything in light pass + pattern analysis + decay + compression.
 */
export async function runGhostAgentDeep(
  orgId: string
): Promise<GhostAgentDeepResult> {
  const startTime = Date.now()
  const supabase = createAdminClient()

  // Start with light pass
  const lightResult = await runGhostAgentLight(orgId)

  let coOccurrencePatterns = 0
  let orphanedEntities = 0
  let staleEntities = 0
  let utilityUpdated = 0
  let decayCycles = 0
  let compression: CompressionResult = { patternsCreated: 0, relationshipsArchived: 0 }

  // 4. Co-occurrence analysis → pattern insights
  try {
    coOccurrencePatterns = await detectCoOccurrencePatterns(supabase, orgId)
  } catch (error) {
    console.error('[GhostAgent:deep] Co-occurrence error:', error)
  }

  // 5. Orphaned entity detection → stale insights
  try {
    orphanedEntities = await detectOrphanedEntities(supabase, orgId)
  } catch (error) {
    console.error('[GhostAgent:deep] Orphaned entity error:', error)
  }

  // 6. Stale high-value entity detection
  try {
    staleEntities = await detectStaleHighValueEntities(supabase, orgId)
  } catch (error) {
    console.error('[GhostAgent:deep] Stale entity error:', error)
  }

  // 7. Recompute utility scores
  try {
    utilityUpdated = await recomputeUtilityScores(orgId)
  } catch (error) {
    console.error('[GhostAgent:deep] Utility recompute error:', error)
  }

  // 8. Run decay cycle
  try {
    const { data } = await supabase.rpc('apply_decay_cycle', {
      p_org_id: orgId,
    })
    // RPC returns TABLE(transitioned_to_dormant, transitioned_to_archived)
    const rows = data as Array<{ transitioned_to_dormant: number; transitioned_to_archived: number }> | null
    if (rows && rows.length > 0) {
      decayCycles = (rows[0].transitioned_to_dormant ?? 0) + (rows[0].transitioned_to_archived ?? 0)
    }
  } catch (error) {
    console.error('[GhostAgent:deep] Decay cycle error:', error)
  }

  // 9. Run compression
  try {
    compression = await runCompression(orgId)
  } catch (error) {
    console.error('[GhostAgent:deep] Compression error:', error)
  }

  return {
    ...lightResult,
    coOccurrencePatterns,
    orphanedEntities,
    staleEntities,
    utilityUpdated,
    decayCycles,
    compression,
    durationMs: Date.now() - startTime,
  }
}

// ─── Detection: Velocity Spikes ──────────────────────────────────────────

async function detectVelocitySpikes(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<number> {
  const { data: spikes } = await supabase.rpc('detect_velocity_spikes', {
    p_org_id: orgId,
    p_spike_threshold: 3.0, // 3x above average
  })

  if (!spikes || (spikes as unknown[]).length === 0) return 0

  let count = 0
  for (const spike of spikes as Array<{
    entity_id: string
    entity_name: string
    recent_7d_count: number
    avg_30d_weekly: number
    spike_ratio: number
  }>) {
    await supabase.rpc('upsert_insight_with_dedupe', {
      p_org_id: orgId,
      p_idempotency_key: `velocity_spike:${spike.entity_id}:${new Date().toISOString().slice(0, 10)}`,
      p_insight_type: 'anomaly',
      p_category: 'velocity_spike',
      p_summary: `Unusual activity on "${spike.entity_name}": ${spike.recent_7d_count} mentions in 7d vs ${spike.avg_30d_weekly.toFixed(1)} avg (${spike.spike_ratio.toFixed(1)}x spike)`,
      p_confidence: Math.min(0.5 + (spike.spike_ratio - 3) * 0.1, 0.95),
      p_entity_ids: [spike.entity_id],
      p_evidence: {
        entity_id: spike.entity_id,
        recent_7d_count: spike.recent_7d_count,
        avg_30d_weekly: spike.avg_30d_weekly,
        spike_ratio: spike.spike_ratio,
      },
      p_action_template: {
        type: 'investigate_anomaly',
        priority: spike.spike_ratio > 5 ? 'high' : 'medium',
        suggested_action: `Review recent activity on "${spike.entity_name}" — unusual spike detected`,
      },
    })
    count++
  }

  return count
}

// ─── Detection: Co-Occurrence Patterns ───────────────────────────────────

async function detectCoOccurrencePatterns(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<number> {
  const { data: pairs } = await supabase.rpc('find_co_occurring_entities', {
    p_org_id: orgId,
    p_min_co_occurrences: 5,
    p_limit: 10,
  })

  if (!pairs || (pairs as unknown[]).length === 0) return 0

  let count = 0
  for (const pair of pairs as Array<{
    entity_a_id: string
    entity_b_id: string
    entity_a_name: string
    entity_b_name: string
    co_occurrence_count: number
  }>) {
    const entityIds = [pair.entity_a_id, pair.entity_b_id].sort()
    await supabase.rpc('upsert_insight_with_dedupe', {
      p_org_id: orgId,
      p_idempotency_key: `co_occurrence:${entityIds.join(':')}`,
      p_insight_type: 'pattern',
      p_category: 'co_occurrence',
      p_summary: `"${pair.entity_a_name}" and "${pair.entity_b_name}" frequently appear together (${pair.co_occurrence_count} co-occurrences)`,
      p_confidence: Math.min(0.4 + pair.co_occurrence_count * 0.05, 0.9),
      p_entity_ids: entityIds,
      p_evidence: {
        entity_a: pair.entity_a_name,
        entity_b: pair.entity_b_name,
        count: pair.co_occurrence_count,
      },
      p_action_template: null,
    })
    count++
  }

  return count
}

// ─── Detection: Orphaned Entities ────────────────────────────────────────

async function detectOrphanedEntities(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<number> {
  // Entities with no active relationships and low mention count
  const { data: orphans } = await supabase
    .from('entities')
    .select('id, name, entity_type, mention_count, last_seen_at')
    .eq('org_id', orgId)
    .eq('state', 'active')
    .eq('is_pinned', false)
    .lt('mention_count', 3)
    .lt('last_seen_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
    .limit(10)

  if (!orphans || orphans.length === 0) return 0

  // Batch check: get all active relationships for candidate entities in one query
  const orphanIds = orphans.map(e => e.id)
  const { data: relatedEntities } = await supabase
    .from('entity_relationships')
    .select('source_entity_id, target_entity_id')
    .is('valid_to', null)
    .or(
      orphanIds.map(id => `source_entity_id.eq.${id}`).join(',') + ',' +
      orphanIds.map(id => `target_entity_id.eq.${id}`).join(',')
    )

  // Build a set of entity IDs that have at least one active relationship
  const entitiesWithRels = new Set<string>()
  if (relatedEntities) {
    for (const rel of relatedEntities) {
      entitiesWithRels.add(rel.source_entity_id)
      entitiesWithRels.add(rel.target_entity_id)
    }
  }

  // Filter to truly orphaned entities (no active relationships)
  let count = 0
  for (const entity of orphans) {
    if (entitiesWithRels.has(entity.id)) continue

    const daysOld = Math.round(
      (Date.now() - new Date(entity.last_seen_at).getTime()) / 86_400_000
    )

    await supabase.rpc('upsert_insight_with_dedupe', {
      p_org_id: orgId,
      p_idempotency_key: `orphaned:${entity.id}`,
      p_insight_type: 'stale',
      p_category: 'orphaned_entity',
      p_summary: `"${entity.name}" (${entity.entity_type}) has no connections and hasn't been mentioned in ${daysOld} days`,
      p_confidence: 0.5,
      p_entity_ids: [entity.id],
      p_evidence: {
        entity_name: entity.name,
        entity_type: entity.entity_type,
        mention_count: entity.mention_count,
        days_since_last_seen: daysOld,
      },
      p_action_template: {
        type: 'cleanup_entity',
        priority: 'low',
        suggested_action: `Review if "${entity.name}" is still relevant`,
      },
    })
    count++
  }

  return count
}

// ─── Detection: Stale High-Value Entities ────────────────────────────────

async function detectStaleHighValueEntities(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<number> {
  // Entities that were once important (high mention count) but haven't been seen recently
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data: staleEntities } = await supabase
    .from('entities')
    .select('id, name, entity_type, mention_count, last_seen_at')
    .eq('org_id', orgId)
    .in('state', ['active', 'dormant'])
    .eq('is_pinned', false)
    .gte('mention_count', 5) // Was important
    .lt('last_seen_at', thirtyDaysAgo) // Not seen in 30d
    .limit(10)

  if (!staleEntities || staleEntities.length === 0) return 0

  let count = 0
  for (const entity of staleEntities) {
    const daysOld = Math.round(
      (Date.now() - new Date(entity.last_seen_at).getTime()) / 86_400_000
    )

    await supabase.rpc('upsert_insight_with_dedupe', {
      p_org_id: orgId,
      p_idempotency_key: `stale_highvalue:${entity.id}`,
      p_insight_type: 'stale',
      p_category: 'stale_high_value',
      p_summary: `Haven't heard about "${entity.name}" (${entity.entity_type}) in ${daysOld} days — previously had ${entity.mention_count} mentions`,
      p_confidence: 0.6,
      p_entity_ids: [entity.id],
      p_evidence: {
        entity_name: entity.name,
        entity_type: entity.entity_type,
        mention_count: entity.mention_count,
        days_since_last_seen: daysOld,
      },
      p_action_template: {
        type: 'follow_up',
        priority: 'medium',
        suggested_action: `Check status of "${entity.name}" — it was frequently discussed but hasn't come up recently`,
      },
    })
    count++
  }

  return count
}
