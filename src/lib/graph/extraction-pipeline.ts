// ─── Background Extraction Pipeline ──────────────────────────────────────
// Runs after each conversation turn (fire-and-forget via waitUntil).
// Extracts entities and relationships from message content using gpt-4o-mini,
// then upserts into the knowledge graph tables in Supabase.
//
// Cost: ~$0.0004 per conversation turn (user + assistant messages).
// Never throws — catches all errors and logs them.

import { createAdminClient } from '@/lib/supabase/admin'
import {
  extractEntitiesAndRelationships,
  generateEmbedding,
  isOpenAIConfigured,
  type ExtractedEntity,
  type ExtractedRelationship,
} from '@/lib/openai/client'
import { runPreStoreGuard, storeContradictions, type ResolvedRelationship } from '@/lib/graph/contradiction-detector'
import { trackUtilityEventBatch } from '@/lib/graph/utility-tracker'
import type { Json } from '@/types/database'

// ─── Types ───────────────────────────────────────────────────────────────

export interface ExtractionParams {
  orgId: string
  conversationId: string
  messageId?: string
  messageContent: string
  role: 'user' | 'assistant'
  /** Raw tool output data from integration tools (emails, calendar, Slack, etc.)
   *  for enriched entity extraction. Only present on assistant-role extractions. */
  toolOutputs?: Array<{ toolName: string; output: string }>
  /** Entity IDs injected into context pack for this conversation turn.
   *  Used to track 'cited' utility events when these entities are re-mentioned. */
  injectedEntityIds?: string[]
}

// ─── Pipeline ────────────────────────────────────────────────────────────

/**
 * Run the background extraction pipeline for a single message.
 * Never throws — catches all errors, logs them, and marks the job as failed.
 */
export async function runExtractionPipeline(params: ExtractionParams): Promise<void> {
  const { orgId, conversationId, messageId, messageContent, role } = params

  if (!isOpenAIConfigured()) return
  // Skip very short messages unless enriched with tool outputs
  if (!messageContent || (messageContent.trim().length < 20 && !params.toolOutputs?.length)) return

  const supabase = createAdminClient()
  const startTime = Date.now()
  let jobId: string | undefined

  // Build extraction input — enriched with tool outputs when available
  let extractionInput = messageContent
  if (params.toolOutputs && params.toolOutputs.length > 0) {
    const toolSummary = params.toolOutputs
      .map(t => `\n--- Data from ${t.toolName} ---\n${t.output}`)
      .join('\n')
    // Cap total tool data to ~12000 chars to stay within token budget
    const cappedToolData = toolSummary.slice(0, 12000)
    extractionInput = `${messageContent}\n\n## Integration Data (extract entities from this too):\n${cappedToolData}`
  }

  try {
    // 1. Create extraction job row
    const { data: job } = await supabase
      .from('extraction_jobs')
      .insert({
        org_id: orgId,
        conversation_id: conversationId,
        message_id: messageId ?? null,
        status: 'processing',
        model_used: process.env.EXTRACTOR_MODEL || 'x-ai/grok-4.1-fast',
      })
      .select('id')
      .single()

    jobId = job?.id

    // 2. Extract entities and relationships via LLM (enriched with tool data when available)
    const extraction = await extractEntitiesAndRelationships(extractionInput)
    const { entities, relationships, usage } = extraction

    if (entities.length === 0 && relationships.length === 0) {
      // Nothing to extract — mark complete
      if (jobId) {
        await supabase
          .from('extraction_jobs')
          .update({
            status: 'completed',
            entities_extracted: 0,
            relationships_extracted: 0,
            tokens_used: usage ?? null,
            duration_ms: Date.now() - startTime,
            completed_at: new Date().toISOString(),
          })
          .eq('id', jobId)
      }
      return
    }

    // 3. Upsert entities
    const entityIdMap = await upsertEntities(supabase, orgId, entities)

    // 4. Upsert relationships (with pre-store guard for contradiction detection)
    let relationshipsCreated = 0

    // Resolve relationship entity IDs
    const resolvedRels: ResolvedRelationship[] = relationships
      .map(rel => ({
        sourceId: entityIdMap.get(normalizeCanonical(rel.source)) ?? '',
        targetId: entityIdMap.get(normalizeCanonical(rel.target)) ?? '',
        source: rel.source,
        target: rel.target,
        type: rel.type,
        properties: rel.properties,
        confidence: rel.confidence,
      }))
      .filter(r => r.sourceId && r.targetId && r.sourceId !== r.targetId)

    // Run pre-store guard to detect contradictions
    const { allowed, blocked, contradictions } = await runPreStoreGuard(
      orgId, conversationId, resolvedRels
    )

    // Only upsert allowed relationships
    for (const rel of allowed) {
      await upsertRelationship(supabase, orgId, conversationId, rel.sourceId, rel.targetId, rel)
      relationshipsCreated++
    }

    // Log blocked relationships for observability
    if (blocked.length > 0) {
      console.warn(
        `[Extraction] Pre-store guard blocked ${blocked.length} relationship(s) due to contradictions:`,
        blocked.map(r => `${r.source} -[${r.type}]-> ${r.target}`).join(', ')
      )
    }

    // Store contradictions (fire-and-forget)
    if (contradictions.length > 0) {
      storeContradictions(orgId, conversationId, contradictions).catch(err =>
        console.error('[Extraction] Failed to store contradictions:', err)
      )
    }

    // 5. Generate embeddings for new/updated entities
    let embeddingsGenerated = 0
    for (const entity of entities) {
      const canonical = normalizeCanonical(entity.name)
      const entityId = entityIdMap.get(canonical)
      if (!entityId) continue

      const embeddingText = `${entity.name}: ${entity.description || entity.type}`
      const embedding = await generateEmbedding(embeddingText)
      if (embedding) {
        await supabase
          .from('entities')
          .update({ embedding: JSON.stringify(embedding) })
          .eq('id', entityId)
        embeddingsGenerated++
      }
    }

    // 5b. Track 'cited' utility for entities that were injected into context
    // and then re-mentioned by the assistant in its response
    if (params.injectedEntityIds && params.injectedEntityIds.length > 0 && role === 'assistant') {
      const extractedIds = new Set(entityIdMap.values())
      const citedIds = params.injectedEntityIds.filter(id => extractedIds.has(id))
      if (citedIds.length > 0) {
        trackUtilityEventBatch(orgId, citedIds, 'cited', conversationId).catch(() => {})
      }
    }

    // 6. Link entities to matching memories
    await linkEntitiesToMemories(supabase, orgId, entityIdMap)

    // 7. Calculate cost estimate
    const promptTokens = usage?.prompt_tokens ?? 0
    const completionTokens = usage?.completion_tokens ?? 0
    const costUsd = (promptTokens * 0.00000015) + (completionTokens * 0.0000006) // gpt-4o-mini pricing

    // 8. Update job as completed
    if (jobId) {
      await supabase
        .from('extraction_jobs')
        .update({
          status: 'completed',
          entities_extracted: entities.length,
          relationships_extracted: relationshipsCreated,
          embeddings_generated: embeddingsGenerated,
          tokens_used: usage ?? null,
          cost_usd: costUsd,
          duration_ms: Date.now() - startTime,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    }

    console.log(
      `[Extraction] ${role} message → ${entities.length} entities, ${relationshipsCreated} relationships` +
      `${blocked.length > 0 ? `, ${blocked.length} blocked` : ''}` +
      `${contradictions.length > 0 ? `, ${contradictions.length} contradictions` : ''}` +
      `, ${embeddingsGenerated} embeddings (${Date.now() - startTime}ms)`
    )
  } catch (error) {
    console.error('[Extraction] Pipeline error:', error)

    // Mark job as failed
    if (jobId) {
      await Promise.resolve(
        supabase
          .from('extraction_jobs')
          .update({
            status: 'failed',
            error: (error as Error).message,
            duration_ms: Date.now() - startTime,
            completed_at: new Date().toISOString(),
          })
          .eq('id', jobId)
      ).catch(() => {}) // Don't throw on cleanup
    }
  }
}

// ─── Entity Upsert ──────────────────────────────────────────────────────

/**
 * Normalize entity name to canonical form for dedup.
 */
export function normalizeCanonical(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Minimum canonical name length for fuzzy (substring) matching. */
const FUZZY_MIN_LENGTH = 4

/**
 * Upsert entities into the entities table.
 * Returns a map of canonical_name → entity UUID.
 *
 * Dedup strategy (in order):
 *   1. Exact match on (org_id, canonical_name, entity_type) — fast path.
 *   2. Fuzzy match: if canonical_name is ≥ 4 chars, check for substring
 *      containment (both directions) against existing entities of the
 *      same type. This catches "Komal" ↔ "Komal Shah" variants.
 *   3. If no match found, insert a new entity.
 */
export async function upsertEntities(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entities: ExtractedEntity[]
): Promise<Map<string, string>> {
  const entityIdMap = new Map<string, string>()

  for (const entity of entities) {
    const canonical = normalizeCanonical(entity.name)

    // ── 1. Exact match (fast path) ──────────────────────────────────
    const { data: exactMatch } = await supabase
      .from('entities')
      .select('id, mention_count, canonical_name')
      .eq('org_id', orgId)
      .eq('canonical_name', canonical)
      .eq('entity_type', entity.type)
      .single()

    if (exactMatch) {
      await bumpEntity(supabase, exactMatch.id, exactMatch.mention_count, entity)
      entityIdMap.set(canonical, exactMatch.id)
      continue
    }

    // ── 2. Fuzzy match — substring containment (same type) ──────────
    // Only attempt for names with enough characters to avoid false positives.
    let fuzzyMatch: { id: string; mention_count: number; canonical_name: string } | null = null

    if (canonical.length >= FUZZY_MIN_LENGTH) {
      // Check if any existing entity's canonical name contains the new name,
      // OR if the new name contains an existing entity's canonical name.
      // We use ilike for case-insensitive substring matching.
      const { data: candidates } = await supabase
        .from('entities')
        .select('id, mention_count, canonical_name')
        .eq('org_id', orgId)
        .eq('entity_type', entity.type)
        .or(`canonical_name.ilike.%${canonical}%,canonical_name.ilike.${canonical.split(' ')[0]}%`)
        .order('mention_count', { ascending: false })
        .limit(5)

      if (candidates && candidates.length > 0) {
        // Score candidates: prefer exact substring containment both ways
        fuzzyMatch = candidates.find(c => {
          const existing = c.canonical_name
          return existing.includes(canonical) || canonical.includes(existing)
        }) ?? null
      }
    }

    if (fuzzyMatch) {
      // Merge into existing entity. If the new name is longer (more specific),
      // update the canonical name and display name to keep the fuller version.
      const shouldUpdateName = canonical.length > fuzzyMatch.canonical_name.length

      await supabase
        .from('entities')
        .update({
          mention_count: fuzzyMatch.mention_count + 1,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...(entity.description ? { description: entity.description } : {}),
          ...(entity.attributes ? { attributes: entity.attributes as Json } : {}),
          // Upgrade to the more specific name if available
          ...(shouldUpdateName
            ? { name: entity.name, canonical_name: canonical }
            : {}),
        })
        .eq('id', fuzzyMatch.id)

      // Map both the current canonical AND the original match's canonical to the same ID
      entityIdMap.set(canonical, fuzzyMatch.id)
      entityIdMap.set(fuzzyMatch.canonical_name, fuzzyMatch.id)

      console.log(
        `[Extraction] Fuzzy matched "${canonical}" → existing "${fuzzyMatch.canonical_name}" (id=${fuzzyMatch.id.slice(0, 8)})`
      )
      continue
    }

    // ── 3. No match — insert new entity ─────────────────────────────
    const { data: newEntity } = await supabase
      .from('entities')
      .insert({
        org_id: orgId,
        entity_type: entity.type,
        name: entity.name,
        canonical_name: canonical,
        description: entity.description ?? null,
        attributes: (entity.attributes ?? {}) as Json,
      })
      .select('id')
      .single()

    if (newEntity) {
      entityIdMap.set(canonical, newEntity.id)
    }
  }

  return entityIdMap
}

/**
 * Bump an existing entity's mention count and merge new data into it.
 */
async function bumpEntity(
  supabase: ReturnType<typeof createAdminClient>,
  entityId: string,
  currentMentionCount: number,
  entity: ExtractedEntity
): Promise<void> {
  await supabase
    .from('entities')
    .update({
      mention_count: currentMentionCount + 1,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(entity.description ? { description: entity.description } : {}),
      ...(entity.attributes ? { attributes: entity.attributes as Json } : {}),
    })
    .eq('id', entityId)
}

// ─── Relationship Upsert ────────────────────────────────────────────────

/**
 * Upsert a single relationship. If an active relationship of the same type
 * exists between the same entities, either update its properties or
 * close it (set valid_to) and create a new one if properties differ.
 */
export async function upsertRelationship(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  conversationId: string,
  sourceId: string,
  targetId: string,
  rel: ExtractedRelationship
): Promise<void> {
  // Check for existing active relationship of the same type
  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id, properties')
    .eq('org_id', orgId)
    .eq('source_entity_id', sourceId)
    .eq('target_entity_id', targetId)
    .eq('relationship_type', rel.type)
    .is('valid_to', null) // Only active relationships
    .single()

  if (existing) {
    // Same relationship exists — just update timestamp
    const existingProps = JSON.stringify(existing.properties || {})
    const newProps = JSON.stringify(rel.properties || {})

    if (existingProps !== newProps) {
      // Properties changed — close old, create new (temporal tracking)
      await supabase
        .from('entity_relationships')
        .update({
          valid_to: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)

      await supabase
        .from('entity_relationships')
        .insert({
          org_id: orgId,
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relationship_type: rel.type,
          properties: (rel.properties ?? {}) as Json,
          confidence: rel.confidence ?? 1.0,
          source_conversation_id: conversationId,
        })
    } else {
      // Same properties — just update timestamps
      await supabase
        .from('entity_relationships')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
  } else {
    // New relationship
    await supabase
      .from('entity_relationships')
      .insert({
        org_id: orgId,
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: rel.type,
        properties: (rel.properties ?? {}) as Json,
        confidence: rel.confidence ?? 1.0,
        source_conversation_id: conversationId,
      })
  }
}

// ─── Memory Linking ─────────────────────────────────────────────────────

/**
 * Link extracted entities to existing memories that mention them
 * in their related_entities array or subject/content.
 */
async function linkEntitiesToMemories(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entityIdMap: Map<string, string>
): Promise<void> {
  if (entityIdMap.size === 0) return

  // Get all memories for this org that have related_entities
  const { data: memories } = await supabase
    .from('memory')
    .select('id, related_entities, subject, content')
    .eq('org_id', orgId)

  if (!memories || memories.length === 0) return

  for (const memory of memories) {
    const relatedEntities = (memory.related_entities as string[]) || []
    const memoryText = `${memory.subject || ''} ${memory.content || ''}`.toLowerCase()

    for (const [canonical, entityId] of entityIdMap) {
      // Check if this entity is mentioned in related_entities or in the memory text
      const isRelated =
        relatedEntities.some(re => normalizeCanonical(re) === canonical) ||
        memoryText.includes(canonical)

      if (isRelated) {
        // Insert link (ignore if already exists via unique constraint)
        await supabase
          .from('memory_entity_links')
          .upsert(
            { memory_id: memory.id, entity_id: entityId },
            { onConflict: 'memory_id,entity_id' }
          )
      }
    }
  }
}
