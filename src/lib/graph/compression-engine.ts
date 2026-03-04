/**
 * Compression Engine — Pattern Promotion
 *
 * Identifies repetitive relationships and compresses them into pattern
 * nodes (graph_insights with type='compression').
 *
 * Process:
 *   1. find_repetitive_relationships → relationship groups
 *   2. For eligible groups (all confidence ≥ 0.7, count ≥ 5):
 *      a. Create pattern node (graph_insight)
 *      b. Archive individual repetitive relationships (set valid_to)
 *      c. Preserve anomalies (outliers kept as active)
 *
 * The compression is reversible — original relationships still exist
 * with valid_to timestamps, and the pattern node's evidence JSONB
 * contains the full trace.
 *
 * Called by ghost agent daily deep pass.
 * Never throws — catches errors and returns partial results.
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ────────────────────────────────────────────────────────────────

export interface CompressionResult {
  patternsCreated: number
  relationshipsArchived: number
}

interface RepetitiveGroup {
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
  source_entity_name: string
  target_entity_name: string
  repetition_count: number
  avg_confidence: number
  conversation_ids: string[]
}

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_REPETITIONS = 5
const MIN_CONFIDENCE = 0.7

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Run compression for an organization.
 * Identifies repetitive relationships and promotes them to pattern nodes.
 */
export async function runCompression(
  orgId: string
): Promise<CompressionResult> {
  const result: CompressionResult = {
    patternsCreated: 0,
    relationshipsArchived: 0,
  }

  const supabase = createAdminClient()

  try {
    // 1. Find repetitive relationship groups
    const { data: groups } = await supabase.rpc('find_repetitive_relationships', {
      p_org_id: orgId,
      p_min_repetitions: MIN_REPETITIONS,
    })

    if (!groups || (groups as unknown[]).length === 0) return result

    // 2. Process each group
    for (const group of groups as unknown as RepetitiveGroup[]) {
      try {
        // Only compress if average confidence is high enough
        if (group.avg_confidence < MIN_CONFIDENCE) continue

        // Create the pattern insight (compression node)
        const idempotencyKey = `compression:${group.source_entity_id}:${group.target_entity_id}:${group.relationship_type}`

        await supabase.rpc('upsert_insight_with_dedupe', {
          p_org_id: orgId,
          p_idempotency_key: idempotencyKey,
          p_insight_type: 'compression',
          p_category: 'repetitive_relationship',
          p_summary: `"${group.source_entity_name}" has "${group.relationship_type}" relationship with "${group.target_entity_name}" across ${group.repetition_count} conversations`,
          p_confidence: group.avg_confidence,
          p_entity_ids: [group.source_entity_id, group.target_entity_id],
          p_evidence: {
            source_entity: group.source_entity_name,
            target_entity: group.target_entity_name,
            relationship_type: group.relationship_type,
            repetition_count: group.repetition_count,
            conversation_ids: group.conversation_ids,
            compressed_at: new Date().toISOString(),
          },
          p_action_template: null,
        })

        result.patternsCreated++

        // Archive the individual repetitive relationships (keep the most recent one active).
        // We explicitly query by created_at to find the most recent instead of relying on
        // ARRAY_AGG ordering (which is not guaranteed in SQL).
        if (group.repetition_count > 1) {
          const { data: allRels } = await supabase
            .from('entity_relationships')
            .select('id, created_at')
            .eq('org_id', orgId)
            .eq('source_entity_id', group.source_entity_id)
            .eq('target_entity_id', group.target_entity_id)
            .eq('relationship_type', group.relationship_type)
            .is('valid_to', null)
            .order('created_at', { ascending: false })

          if (allRels && allRels.length > 1) {
            // Keep the first (most recent), archive the rest
            const toArchive = allRels.slice(1).map(r => r.id)

            const { data: archived } = await supabase
              .from('entity_relationships')
              .update({
                valid_to: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .in('id', toArchive)
              .is('valid_to', null)
              .select('id')

            result.relationshipsArchived += archived?.length ?? 0
          }
        }
      } catch (error) {
        console.error(`[Compression] Error processing group:`, error)
      }
    }
  } catch (error) {
    console.error('[Compression] Error:', error)
  }

  return result
}
