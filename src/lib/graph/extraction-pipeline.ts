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
import type { Json } from '@/types/database'

// ─── Types ───────────────────────────────────────────────────────────────

export interface ExtractionParams {
  orgId: string
  conversationId: string
  messageId?: string
  messageContent: string
  role: 'user' | 'assistant'
}

// ─── Pipeline ────────────────────────────────────────────────────────────

/**
 * Run the background extraction pipeline for a single message.
 * Never throws — catches all errors, logs them, and marks the job as failed.
 */
export async function runExtractionPipeline(params: ExtractionParams): Promise<void> {
  const { orgId, conversationId, messageId, messageContent, role } = params

  if (!isOpenAIConfigured()) return
  if (!messageContent || messageContent.trim().length < 20) return

  const supabase = createAdminClient()
  const startTime = Date.now()
  let jobId: string | undefined

  try {
    // 1. Create extraction job row
    const { data: job } = await supabase
      .from('extraction_jobs')
      .insert({
        org_id: orgId,
        conversation_id: conversationId,
        message_id: messageId ?? null,
        status: 'processing',
        model_used: process.env.EXTRACTOR_MODEL || 'openai/gpt-4o-mini',
      })
      .select('id')
      .single()

    jobId = job?.id

    // 2. Extract entities and relationships via LLM
    const extraction = await extractEntitiesAndRelationships(messageContent)
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

    // 4. Upsert relationships
    let relationshipsCreated = 0
    for (const rel of relationships) {
      const sourceId = entityIdMap.get(normalizeCanonical(rel.source))
      const targetId = entityIdMap.get(normalizeCanonical(rel.target))
      if (!sourceId || !targetId || sourceId === targetId) continue

      await upsertRelationship(supabase, orgId, conversationId, sourceId, targetId, rel)
      relationshipsCreated++
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
      `[Extraction] ${role} message → ${entities.length} entities, ${relationshipsCreated} relationships, ${embeddingsGenerated} embeddings (${Date.now() - startTime}ms)`
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
function normalizeCanonical(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Upsert entities into the entities table.
 * Returns a map of canonical_name → entity UUID.
 */
async function upsertEntities(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entities: ExtractedEntity[]
): Promise<Map<string, string>> {
  const entityIdMap = new Map<string, string>()

  for (const entity of entities) {
    const canonical = normalizeCanonical(entity.name)

    // Check if entity already exists
    const { data: existing } = await supabase
      .from('entities')
      .select('id, mention_count')
      .eq('org_id', orgId)
      .eq('canonical_name', canonical)
      .eq('entity_type', entity.type)
      .single()

    if (existing) {
      // Update existing: bump mention count, update last_seen
      await supabase
        .from('entities')
        .update({
          mention_count: existing.mention_count + 1,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Update description if new one is longer/better
          ...(entity.description ? { description: entity.description } : {}),
          // Merge attributes
          ...(entity.attributes ? { attributes: entity.attributes as Json } : {}),
        })
        .eq('id', existing.id)

      entityIdMap.set(canonical, existing.id)
    } else {
      // Insert new entity
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
  }

  return entityIdMap
}

// ─── Relationship Upsert ────────────────────────────────────────────────

/**
 * Upsert a single relationship. If an active relationship of the same type
 * exists between the same entities, either update its properties or
 * close it (set valid_to) and create a new one if properties differ.
 */
async function upsertRelationship(
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
