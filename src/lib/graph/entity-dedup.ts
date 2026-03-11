/**
 * Entity Deduplication & Hygiene Engine
 *
 * Runs as part of the weekly tuning cron to clean up the knowledge graph:
 *
 *   1. **Cross-type dedup**: Same canonical name across different entity_types
 *      (e.g., "axari" as vendor AND project AND tool) — merge into one canonical
 *      entity and alias the rest.
 *
 *   2. **Fuzzy dedup**: Near-identical canonical names within the same type
 *      (e.g., "komal shah", "komal nawandar" → keep both but link if same person;
 *       "keyvalue", "keyvalue systems" → merge).
 *
 *   3. **Orphan cleanup**: Entities with zero active relationships AND
 *      mention_count ≤ 1 AND older than 14 days → mark as archived.
 *
 * All operations are idempotent and reversible (we archive, never hard-delete).
 * Never throws — catches all errors and returns partial results.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { upsertEntityAliases } from '@/lib/graph/entity-resolution'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export interface DedupResult {
  crossTypeMerges: number
  fuzzyMerges: number
  orphansArchived: number
  errors: string[]
}

interface EntityRow {
  id: string
  org_id: string
  entity_type: string
  name: string
  canonical_name: string
  mention_count: number
  created_at: string
  last_seen_at: string
  state: string | null
}

// ─── Constants ────────────────────────────────────────────────────────────

/** Entity types that represent "organizations" and can be cross-type merged. */
const ORG_LIKE_TYPES = new Set(['vendor', 'tool', 'team', 'project', 'customer'])

/** Minimum mention count to keep an orphan entity alive. */
const ORPHAN_MIN_MENTIONS = 2

/** Minimum age (in days) before an orphan can be archived. */
const ORPHAN_MIN_AGE_DAYS = 14

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Run the full dedup + hygiene pass for an organization.
 */
export async function runEntityDedup(orgId: string): Promise<DedupResult> {
  const result: DedupResult = {
    crossTypeMerges: 0,
    fuzzyMerges: 0,
    orphansArchived: 0,
    errors: [],
  }

  const supabase = createAdminClient()

  try {
    // Phase 1: Cross-type dedup
    const crossType = await dedupCrossType(supabase, orgId)
    result.crossTypeMerges = crossType.merged
    result.errors.push(...crossType.errors)
  } catch (err) {
    result.errors.push(`Cross-type dedup failed: ${(err as Error).message}`)
  }

  try {
    // Phase 2: Fuzzy name dedup (same type)
    const fuzzy = await dedupFuzzyNames(supabase, orgId)
    result.fuzzyMerges = fuzzy.merged
    result.errors.push(...fuzzy.errors)
  } catch (err) {
    result.errors.push(`Fuzzy dedup failed: ${(err as Error).message}`)
  }

  try {
    // Phase 3: Orphan cleanup
    const orphans = await archiveOrphans(supabase, orgId)
    result.orphansArchived = orphans.archived
    result.errors.push(...orphans.errors)
  } catch (err) {
    result.errors.push(`Orphan cleanup failed: ${(err as Error).message}`)
  }

  console.log(
    `[EntityDedup] org=${orgId.slice(0, 8)} → ` +
      `crossType=${result.crossTypeMerges}, fuzzy=${result.fuzzyMerges}, ` +
      `orphans=${result.orphansArchived}` +
      (result.errors.length > 0 ? `, errors=${result.errors.length}` : '')
  )

  return result
}

// ─── Phase 1: Cross-Type Dedup ────────────────────────────────────────────

/**
 * Find entities with the same canonical_name but different entity_types.
 * For org-like types (vendor/tool/team/project), keep the highest-mention one
 * and merge the rest.
 */
async function dedupCrossType(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<{ merged: number; errors: string[] }> {
  let merged = 0
  const errors: string[] = []

  // Find canonical names that appear in multiple org-like entity types
  const { data: entities } = await supabase
    .from('entities')
    .select('id, entity_type, name, canonical_name, mention_count, created_at, last_seen_at, state')
    .eq('org_id', orgId)
    .in('state', ['active', null as unknown as string])
    .order('canonical_name')

  if (!entities || entities.length === 0) return { merged, errors }

  // Group by canonical_name
  const groups = new Map<string, EntityRow[]>()
  for (const e of entities as EntityRow[]) {
    const key = e.canonical_name
    const group = groups.get(key) ?? []
    group.push(e)
    groups.set(key, group)
  }

  for (const [canonical, group] of groups) {
    // Only process groups with multiple entity types
    const types = new Set(group.map(e => e.entity_type))
    if (types.size <= 1) continue

    // Only merge org-like types
    const orgLikeEntities = group.filter(e => ORG_LIKE_TYPES.has(e.entity_type))
    if (orgLikeEntities.length <= 1) continue

    // Keep the entity with the highest mention count
    orgLikeEntities.sort((a, b) => b.mention_count - a.mention_count)
    const keep = orgLikeEntities[0]
    const toMerge = orgLikeEntities.slice(1)

    for (const mergeEntity of toMerge) {
      try {
        await mergeEntityInto(supabase, keep.id, mergeEntity.id)
        merged++
        console.log(
          `[EntityDedup] Cross-type merged "${canonical}" (${mergeEntity.entity_type}) → (${keep.entity_type})`
        )
      } catch (err) {
        errors.push(`Failed to merge ${mergeEntity.id} into ${keep.id}: ${(err as Error).message}`)
      }
    }
  }

  return { merged, errors }
}

// ─── Phase 2: Fuzzy Name Dedup ────────────────────────────────────────────

/**
 * Find entities within the same type where one canonical name is a substring
 * of another (e.g., "keyvalue" ↔ "keyvalue systems").
 * Merge the shorter-named entity into the longer-named one.
 */
async function dedupFuzzyNames(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<{ merged: number; errors: string[] }> {
  let merged = 0
  const errors: string[] = []

  // Get all active entities, grouped by type
  const { data: entities } = await supabase
    .from('entities')
    .select('id, entity_type, name, canonical_name, mention_count, created_at, last_seen_at, state')
    .eq('org_id', orgId)
    .in('state', ['active', null as unknown as string])
    .order('entity_type')
    .order('canonical_name')

  if (!entities || entities.length === 0) return { merged, errors }

  // Group by entity_type
  const byType = new Map<string, EntityRow[]>()
  for (const e of entities as EntityRow[]) {
    const group = byType.get(e.entity_type) ?? []
    group.push(e)
    byType.set(e.entity_type, group)
  }

  // Track already-merged IDs to avoid double-processing
  const mergedIds = new Set<string>()

  for (const [, typeGroup] of byType) {
    // Compare each pair within the type group
    for (let i = 0; i < typeGroup.length; i++) {
      if (mergedIds.has(typeGroup[i].id)) continue

      for (let j = i + 1; j < typeGroup.length; j++) {
        if (mergedIds.has(typeGroup[j].id)) continue

        const a = typeGroup[i]
        const b = typeGroup[j]

        // Check substring containment (both directions)
        const aContainsB = a.canonical_name.includes(b.canonical_name) && b.canonical_name.length >= 4
        const bContainsA = b.canonical_name.includes(a.canonical_name) && a.canonical_name.length >= 4

        if (!aContainsB && !bContainsA) continue

        // Keep the one with the longer (more specific) canonical name.
        // If same length, keep the one with higher mention count.
        let keep: EntityRow
        let merge: EntityRow

        if (a.canonical_name.length !== b.canonical_name.length) {
          keep = a.canonical_name.length > b.canonical_name.length ? a : b
          merge = keep === a ? b : a
        } else {
          keep = a.mention_count >= b.mention_count ? a : b
          merge = keep === a ? b : a
        }

        try {
          await mergeEntityInto(supabase, keep.id, merge.id)
          mergedIds.add(merge.id)
          merged++
          console.log(
            `[EntityDedup] Fuzzy merged "${merge.canonical_name}" → "${keep.canonical_name}"`
          )
        } catch (err) {
          errors.push(`Fuzzy merge ${merge.id} → ${keep.id}: ${(err as Error).message}`)
        }
      }
    }
  }

  return { merged, errors }
}

// ─── Phase 3: Orphan Cleanup ──────────────────────────────────────────────

/**
 * Archive entities that have:
 *  - Zero active relationships (source or target)
 *  - mention_count ≤ ORPHAN_MIN_MENTIONS
 *  - Created more than ORPHAN_MIN_AGE_DAYS ago
 *  - Not pinned
 */
async function archiveOrphans(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string
): Promise<{ archived: number; errors: string[] }> {
  let archived = 0
  const errors: string[] = []

  const cutoff = new Date(Date.now() - ORPHAN_MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Get entities with zero active relationships
  // We use a subquery approach: get all entity IDs that appear in active relationships,
  // then find entities NOT in that set.
  const { data: connectedIds } = await supabase
    .from('entity_relationships')
    .select('source_entity_id, target_entity_id')
    .eq('org_id', orgId)
    .is('valid_to', null)

  if (!connectedIds) return { archived, errors }

  // Build set of all connected entity IDs
  const connectedSet = new Set<string>()
  for (const rel of connectedIds) {
    connectedSet.add(rel.source_entity_id)
    connectedSet.add(rel.target_entity_id)
  }

  // Get all active entities
  const { data: allEntities } = await supabase
    .from('entities')
    .select('id, mention_count, is_pinned, created_at, canonical_name')
    .eq('org_id', orgId)
    .in('state', ['active', null as unknown as string])
    .lte('created_at', cutoff)
    .lte('mention_count', ORPHAN_MIN_MENTIONS)

  if (!allEntities) return { archived, errors }

  // Find orphans: not connected + low mentions + old enough + not pinned
  const orphanIds = allEntities
    .filter(e => !connectedSet.has(e.id) && !e.is_pinned)
    .map(e => e.id)

  if (orphanIds.length === 0) return { archived, errors }

  // Archive in batches of 50
  for (let i = 0; i < orphanIds.length; i += 50) {
    const batch = orphanIds.slice(i, i + 50)
    const { data: updated, error } = await supabase
      .from('entities')
      .update({
        state: 'archived',
        updated_at: new Date().toISOString(),
      })
      .in('id', batch)
      .select('id')

    if (error) {
      errors.push(`Orphan archive batch failed: ${error.message}`)
    } else {
      archived += updated?.length ?? 0
    }
  }

  if (archived > 0) {
    console.log(`[EntityDedup] Archived ${archived} orphan entities`)
  }

  return { archived, errors }
}

// ─── Entity Merge Utility ──────────────────────────────────────────────────

/**
 * Merge one entity into another:
 *  - Re-point all relationships (source + target) from mergeId → keepId
 *  - Merge memory_entity_links
 *  - Combine mention counts
 *  - Archive the merged entity
 *
 * Idempotent: if mergeId is already archived, this is a no-op.
 */
async function mergeEntityInto(
  supabase: ReturnType<typeof createAdminClient>,
  keepId: string,
  mergeId: string
): Promise<void> {
  if (keepId === mergeId) return

  // 1. Re-point source_entity_id references
  await supabase
    .from('entity_relationships')
    .update({ source_entity_id: keepId, updated_at: new Date().toISOString() })
    .eq('source_entity_id', mergeId)
    .is('valid_to', null)

  // 2. Re-point target_entity_id references
  await supabase
    .from('entity_relationships')
    .update({ target_entity_id: keepId, updated_at: new Date().toISOString() })
    .eq('target_entity_id', mergeId)
    .is('valid_to', null)

  // 3. Re-point memory_entity_links (ignore conflicts via onConflict)
  const { data: memLinks } = await supabase
    .from('memory_entity_links')
    .select('memory_id')
    .eq('entity_id', mergeId)

  if (memLinks && memLinks.length > 0) {
    for (const link of memLinks) {
      await supabase
        .from('memory_entity_links')
        .upsert(
          { memory_id: link.memory_id, entity_id: keepId },
          { onConflict: 'memory_id,entity_id' }
        )
    }
    // Remove old links
    await supabase
      .from('memory_entity_links')
      .delete()
      .eq('entity_id', mergeId)
  }

  // 4. Update graph_insights related_entity_ids arrays
  // (Replace mergeId with keepId in any array that contains mergeId)
  const { data: insights } = await supabase
    .from('graph_insights')
    .select('id, related_entity_ids')
    .contains('related_entity_ids', [mergeId])

  if (insights && insights.length > 0) {
    for (const insight of insights) {
      const ids = (insight.related_entity_ids as string[])
        .map(id => (id === mergeId ? keepId : id))
        .filter((id, idx, arr) => arr.indexOf(id) === idx) // dedupe
      await supabase
        .from('graph_insights')
        .update({ related_entity_ids: ids })
        .eq('id', insight.id)
    }
  }

  // 5. Bump keep entity's mention count with merge entity's count
  const { data: mergeEntity } = await supabase
    .from('entities')
    .select('mention_count, attributes, description, name, canonical_name, entity_type, org_id')
    .eq('id', mergeId)
    .single()

  if (mergeEntity) {
    const { data: keepEntity } = await supabase
      .from('entities')
      .select('mention_count, attributes, description')
      .eq('id', keepId)
      .single()

    if (keepEntity) {
      if (mergeEntity.name && mergeEntity.canonical_name && mergeEntity.entity_type && mergeEntity.org_id) {
        await upsertEntityAliases({
          supabase,
          orgId: mergeEntity.org_id,
          entityId: keepId,
          entityType: mergeEntity.entity_type,
          alias: mergeEntity.name,
          aliasKind: 'merged',
          confidence: 0.95,
          source: 'entity_dedup_merge',
        })
      }

      await supabase
        .from('entities')
        .update({
          mention_count: keepEntity.mention_count + mergeEntity.mention_count,
          // Keep longer description
          ...(!keepEntity.description && mergeEntity.description
            ? { description: mergeEntity.description }
            : {}),
          // Merge attributes (keep entity's attributes take precedence)
          attributes: {
            ...((mergeEntity.attributes ?? {}) as Record<string, Json>),
            ...((keepEntity.attributes ?? {}) as Record<string, Json>),
          } as Json,
          updated_at: new Date().toISOString(),
        })
        .eq('id', keepId)
    }
  }

  // 6. Archive the merged entity
  await supabase
    .from('entities')
    .update({
      state: 'archived',
      updated_at: new Date().toISOString(),
    })
    .eq('id', mergeId)

  // 7. Remove self-referential relationships that may have been created by the merge
  await supabase
    .from('entity_relationships')
    .update({ valid_to: new Date().toISOString() })
    .eq('source_entity_id', keepId)
    .eq('target_entity_id', keepId)
    .is('valid_to', null)
}
