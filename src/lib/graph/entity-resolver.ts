// ─── Entity Resolver ─────────────────────────────────────────────────────────
// Resolves person references (name + optional email) to knowledge graph entity
// IDs. Used by meeting-processor to link action item owners and decision makers
// to their entity records.
//
// Resolution strategy (3-tier):
//   1. Email match   — most reliable, checks attributes->>'email'
//   2. Exact canonical name match
//   3. Fuzzy name match — substring containment (reuses extraction-pipeline pattern)
//
// If no entity found and we have enough info, creates a new person entity.

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeCanonical } from './extraction-pipeline'
import type { Json } from '@/types/database'

type AdminClient = ReturnType<typeof createAdminClient>

const FUZZY_MIN_LENGTH = 4

/**
 * Resolve a person reference (name + optional email) to a knowledge graph entity ID.
 *
 * Returns the entity ID if found/created, or null if insufficient info to resolve.
 */
export async function resolvePersonEntity(
  supabase: AdminClient,
  orgId: string,
  name: string | null,
  email: string | null
): Promise<string | null> {
  if (!name && !email) return null

  // ── 1. Email match (most reliable) ──────────────────────────────────────
  if (email) {
    const { data: emailMatch } = await supabase
      .from('entities')
      .select('id')
      .eq('org_id', orgId)
      .eq('entity_type', 'person')
      .eq('attributes->>email', email)
      .limit(1)
      .maybeSingle()

    if (emailMatch) return emailMatch.id
  }

  // Need a name for canonical/fuzzy matching
  if (!name) return null
  const canonical = normalizeCanonical(name)
  if (!canonical) return null

  // ── 2. Exact canonical name match ───────────────────────────────────────
  const { data: exactMatch } = await supabase
    .from('entities')
    .select('id')
    .eq('org_id', orgId)
    .eq('entity_type', 'person')
    .eq('canonical_name', canonical)
    .limit(1)
    .maybeSingle()

  if (exactMatch) {
    // If we have an email and the entity doesn't, enrich it
    if (email) {
      await mergeEmailAttribute(supabase, exactMatch.id, email)
    }
    return exactMatch.id
  }

  // ── 3. Fuzzy name match (substring containment) ─────────────────────────
  if (canonical.length >= FUZZY_MIN_LENGTH) {
    const firstName = canonical.split(' ')[0]
    const { data: candidates } = await supabase
      .from('entities')
      .select('id, canonical_name')
      .eq('org_id', orgId)
      .eq('entity_type', 'person')
      .or(`canonical_name.ilike.%${canonical}%,canonical_name.ilike.${firstName}%`)
      .order('mention_count', { ascending: false })
      .limit(5)

    if (candidates && candidates.length > 0) {
      const fuzzyMatch = candidates.find(c => {
        const existing = c.canonical_name
        return existing.includes(canonical) || canonical.includes(existing)
      })

      if (fuzzyMatch) {
        if (email) {
          await mergeEmailAttribute(supabase, fuzzyMatch.id, email)
        }
        return fuzzyMatch.id
      }
    }
  }

  // ── 4. No match — create a new person entity ───────────────────────────
  // Only if we have a meaningful name (not "Unknown")
  if (canonical === 'unknown' || canonical.length < 2) return null

  const attributes: Record<string, string> = {}
  if (email) attributes.email = email

  const { data: newEntity } = await supabase
    .from('entities')
    .insert({
      org_id: orgId,
      entity_type: 'person',
      name: name.trim(),
      canonical_name: canonical,
      description: email ? `Contact: ${email}` : null,
      attributes: attributes as unknown as Json,
    })
    .select('id')
    .single()

  if (newEntity) {
    console.log(`[entity-resolver] Created person entity "${canonical}" (${email || 'no email'})`)
    return newEntity.id
  }

  return null
}

/**
 * Batch-resolve multiple person references. Deduplicates lookups for the same
 * name/email combination and returns a map keyed by index.
 */
export async function resolvePersonEntities(
  supabase: AdminClient,
  orgId: string,
  people: Array<{ name: string | null; email: string | null }>
): Promise<Map<number, string | null>> {
  const results = new Map<number, string | null>()

  // Deduplicate: group indices by unique (name|email) key
  const seen = new Map<string, { indices: number[]; name: string | null; email: string | null }>()

  for (let i = 0; i < people.length; i++) {
    const p = people[i]
    const key = `${(p.name || '').toLowerCase().trim()}|${(p.email || '').toLowerCase().trim()}`
    const existing = seen.get(key)
    if (existing) {
      existing.indices.push(i)
    } else {
      seen.set(key, { indices: [i], name: p.name, email: p.email })
    }
  }

  // Resolve each unique person once
  for (const entry of seen.values()) {
    const entityId = await resolvePersonEntity(supabase, orgId, entry.name, entry.email)
    for (const idx of entry.indices) {
      results.set(idx, entityId)
    }
  }

  return results
}

/**
 * Merge an email into an entity's attributes if not already present.
 */
async function mergeEmailAttribute(
  supabase: AdminClient,
  entityId: string,
  email: string
): Promise<void> {
  const { data: entity } = await supabase
    .from('entities')
    .select('attributes')
    .eq('id', entityId)
    .single()

  if (!entity) return

  const attrs = (entity.attributes as Record<string, unknown>) || {}
  if (attrs.email) return // Already has email

  await supabase
    .from('entities')
    .update({
      attributes: { ...attrs, email } as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entityId)
}
