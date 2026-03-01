import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, isOpenAIConfigured } from '@/lib/openai/client'
import type { Database } from '@/types/database'

type Memory = Database['public']['Tables']['memory']['Row']

export function createMemoryTools(orgId: string) {
  const supabase = createAdminClient()

  // ─── recall_memory — Hybrid Search (text + vector + graph) ─────────

  const recallMemory = tool(
    'recall_memory',
    'Search institutional memory for relevant context. Uses hybrid search combining full-text, semantic similarity, and knowledge graph traversal for comprehensive recall.',
    {
      query: z.string().describe('Search query to find relevant memories'),
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact']).optional(),
      limit: z.number().optional().default(10),
      include_graph_context: z.boolean().optional().default(true).describe('Include related entities and connections from the knowledge graph'),
    },
    async (args) => {
      console.log(`[Tool:recall_memory] Starting hybrid search query="${args.query}", category=${args.category}`)
      try {
        type ScoredMemory = Memory & { _score: number; _source: string }
        const results: Map<string, ScoredMemory> = new Map()

        // ── Strategy 1: Full-text search ──────────────────────────────
        let textSearchData: Memory[] | null = null
        {
          let q = supabase
            .from('memory')
            .select('*')
            .eq('org_id', orgId)
            .textSearch('subject', args.query, { type: 'websearch' })
            .order('confidence', { ascending: false })
            .limit(args.limit)

          if (args.category) q = q.eq('category', args.category)

          const { data } = await q
          textSearchData = data as Memory[] | null
        }

        if (textSearchData) {
          for (const mem of textSearchData) {
            results.set(mem.id, { ...mem, _score: 0.3 * (mem.confidence ?? 0.5), _source: 'text' })
          }
        }

        // Fallback ilike if full-text returns nothing
        if (!textSearchData || textSearchData.length === 0) {
          const { data: fallbackData } = await supabase
            .from('memory')
            .select('*')
            .eq('org_id', orgId)
            .or(`subject.ilike.%${args.query}%,content.ilike.%${args.query}%`)
            .limit(args.limit)

          if (fallbackData) {
            for (const mem of fallbackData as Memory[]) {
              results.set(mem.id, { ...mem, _score: 0.2 * (mem.confidence ?? 0.5), _source: 'ilike' })
            }
          }
        }

        // ── Strategy 2: Vector similarity search ─────────────────────
        if (isOpenAIConfigured()) {
          try {
            const queryEmbedding = await generateEmbedding(args.query)
            if (queryEmbedding) {
              const { data: vectorData } = await supabase.rpc('search_memories_by_embedding', {
                p_org_id: orgId,
                p_embedding: JSON.stringify(queryEmbedding),
                p_limit: args.limit,
                p_category: args.category ?? null,
              })

              if (vectorData) {
                for (const vm of vectorData as Array<{
                  memory_id: string
                  subject: string
                  content: string
                  category: string
                  confidence: number
                  similarity: number
                  related_entities: string[]
                  created_at: string
                }>) {
                  const existing = results.get(vm.memory_id)
                  const vectorScore = 0.4 * (vm.similarity ?? 0)
                  if (existing) {
                    existing._score += vectorScore
                    existing._source += '+vector'
                  } else {
                    // Create a minimal memory-like entry for vector-only results
                    results.set(vm.memory_id, {
                      id: vm.memory_id,
                      org_id: orgId,
                      subject: vm.subject,
                      content: vm.content,
                      category: vm.category,
                      confidence: vm.confidence,
                      related_entities: vm.related_entities,
                      created_at: vm.created_at,
                      updated_at: vm.created_at,
                      source: null,
                      _score: vectorScore,
                      _source: 'vector',
                    } as ScoredMemory)
                  }
                }
              }
            }
          } catch (vecErr) {
            console.warn('[Tool:recall_memory] Vector search failed (graceful fallback):', vecErr)
          }
        }

        // ── Strategy 3: Graph traversal (entity-linked memories) ─────
        if (args.include_graph_context) {
          try {
            // Find entities matching the query
            const { data: matchingEntities } = await supabase
              .from('entities')
              .select('id')
              .eq('org_id', orgId)
              .or(`name.ilike.%${args.query}%,canonical_name.ilike.%${args.query.toLowerCase()}%`)
              .limit(5)

            if (matchingEntities && matchingEntities.length > 0) {
              const entityIds = matchingEntities.map(e => e.id)

              // Get memories linked to these entities
              const { data: linkedMemories } = await supabase
                .from('memory_entity_links')
                .select('memory_id, entity_id')
                .in('entity_id', entityIds)

              if (linkedMemories && linkedMemories.length > 0) {
                const memoryIds = [...new Set(linkedMemories.map(l => l.memory_id))]
                const { data: graphMemories } = await supabase
                  .from('memory')
                  .select('*')
                  .in('id', memoryIds)
                  .limit(args.limit)

                if (graphMemories) {
                  for (const mem of graphMemories) {
                    const existing = results.get(mem.id)
                    const graphScore = 0.2
                    if (existing) {
                      existing._score += graphScore
                      existing._source += '+graph'
                    } else {
                      results.set(mem.id, { ...mem, _score: graphScore, _source: 'graph' })
                    }
                  }
                }
              }
            }
          } catch (graphErr) {
            console.warn('[Tool:recall_memory] Graph search failed (graceful fallback):', graphErr)
          }
        }

        // ── Merge, rank, and return ──────────────────────────────────
        const ranked = Array.from(results.values())
          .sort((a, b) => b._score - a._score)
          .slice(0, args.limit)
          .map(({ _score, _source, ...mem }) => ({
            ...mem,
            _relevance: { score: Math.round(_score * 100) / 100, sources: _source },
          }))

        console.log(`[Tool:recall_memory] Hybrid result: ${ranked.length} memories (sources: ${ranked.map(r => r._relevance.sources).join(', ')})`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(ranked, null, 2) }] }
      } catch (e) {
        console.error(`[Tool:recall_memory] EXCEPTION:`, e)
        return { content: [{ type: 'text' as const, text: `Error recalling memory: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Recall Memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  // ─── store_memory — Enhanced with embedding + entity linking ───────

  const storeMemory = tool(
    'store_memory',
    'Store a new piece of institutional memory. Use this when the user shares important context, makes a decision, or reveals a preference. Automatically generates semantic embeddings and links to known entities.',
    {
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact']),
      subject: z.string(),
      content: z.string(),
      source: z.string().optional(),
      confidence: z.number().min(0).max(1).optional().default(1.0),
      related_entities: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const { data, error } = await supabase
          .from('memory')
          .insert({
            org_id: orgId,
            category: args.category,
            subject: args.subject,
            content: args.content,
            source: args.source,
            confidence: args.confidence,
            related_entities: args.related_entities,
          })
          .select()
          .single()

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
        const mem = data as Memory

        // Background: generate embedding for the new memory
        if (isOpenAIConfigured()) {
          const embeddingText = `${args.subject}: ${args.content}`
          generateEmbedding(embeddingText).then(async (embedding) => {
            if (embedding) {
              await supabase.from('memory_embeddings').insert({
                memory_id: mem.id,
                embedding: JSON.stringify(embedding),
              })
            }
          }).catch(err => console.warn('[store_memory] Embedding generation failed:', err))

          // Link to existing entities that match related_entities
          if (args.related_entities && args.related_entities.length > 0) {
            const canonicals = args.related_entities.map(re => re.toLowerCase().trim())
            Promise.resolve(
              supabase
                .from('entities')
                .select('id, canonical_name')
                .eq('org_id', orgId)
                .in('canonical_name', canonicals)
            ).then(({ data: matchedEntities }) => {
              if (matchedEntities) {
                for (const entity of matchedEntities) {
                  Promise.resolve(
                    supabase
                      .from('memory_entity_links')
                      .upsert(
                        { memory_id: mem.id, entity_id: entity.id },
                        { onConflict: 'memory_id,entity_id' }
                      )
                  ).catch(() => {})
                }
              }
            }).catch(() => {})
          }
        }

        return { content: [{ type: 'text' as const, text: `Memory stored: ${mem.subject} (${mem.id})` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error storing memory: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Store Memory', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  )

  // ─── update_memory ────────────────────────────────────────────────

  const updateMemory = tool(
    'update_memory',
    'Update an existing memory entry. Use this to adjust confidence, update content, or correct stale memories.',
    {
      id: z.string(),
      content: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact']).optional(),
    },
    async (args) => {
      const { id, ...updates } = args
      const updateData: Record<string, unknown> = {}
      if (updates.content) updateData.content = updates.content
      if (updates.confidence !== undefined) updateData.confidence = updates.confidence
      if (updates.category) updateData.category = updates.category

      const { error } = await supabase
        .from('memory')
        .update(updateData)
        .eq('id', id)
        .eq('org_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
      return { content: [{ type: 'text' as const, text: `Memory ${id} updated.` }] }
    },
    { annotations: { title: 'Update Memory', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  // ─── query_entity_graph — Knowledge Graph Traversal ───────────────

  const queryEntityGraph = tool(
    'query_entity_graph',
    'Traverse the knowledge graph from a named entity. Shows connected people, projects, controls, decisions, and their relationships. Use this to explore "everything connected to X".',
    {
      entity_name: z.string().describe('Name of the entity to start from (e.g., "Sarah Chen", "SOC2 Remediation")'),
      entity_type: z.enum(['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process']).optional(),
      max_hops: z.number().min(1).max(3).optional().default(2).describe('How many relationship hops to traverse (1-3)'),
      relationship_type: z.string().optional().describe('Filter to specific relationship type (e.g., "manages", "depends_on")'),
      active_only: z.boolean().optional().default(true).describe('Only include currently active relationships'),
    },
    async (args) => {
      console.log(`[Tool:query_entity_graph] entity="${args.entity_name}", hops=${args.max_hops}`)
      try {
        // Find the starting entity
        let entityQuery = supabase
          .from('entities')
          .select('id, name, entity_type, description, mention_count')
          .eq('org_id', orgId)
          .ilike('canonical_name', `%${args.entity_name.toLowerCase().trim()}%`)

        if (args.entity_type) entityQuery = entityQuery.eq('entity_type', args.entity_type)

        const { data: entities } = await entityQuery.limit(1)

        if (!entities || entities.length === 0) {
          return { content: [{ type: 'text' as const, text: `No entity found matching "${args.entity_name}". Try a different name or check spelling.` }] }
        }

        const startEntity = entities[0]

        // Traverse the graph using the RPC function
        const { data: neighborhood, error } = await supabase.rpc('get_entity_neighborhood', {
          p_entity_id: startEntity.id,
          p_org_id: orgId,
          p_max_hops: args.max_hops,
          p_active_only: args.active_only,
        })

        if (error) {
          return { content: [{ type: 'text' as const, text: `Graph traversal error: ${error.message}` }] }
        }

        // Filter by relationship_type if specified
        let results = neighborhood || []
        if (args.relationship_type) {
          results = results.filter((r: { relationship_type: string | null }) =>
            r.relationship_type === args.relationship_type || r.relationship_type === null // Include the start node
          )
        }

        // Also fetch linked memories for the start entity
        const { data: linkedMemories } = await supabase
          .from('memory_entity_links')
          .select('memory_id')
          .eq('entity_id', startEntity.id)

        let memoryContext: Memory[] = []
        if (linkedMemories && linkedMemories.length > 0) {
          const memoryIds = linkedMemories.map(l => l.memory_id)
          const { data: memories } = await supabase
            .from('memory')
            .select('*')
            .in('id', memoryIds)
            .order('created_at', { ascending: false })
            .limit(5)
          memoryContext = memories || []
        }

        const response = {
          entity: startEntity,
          neighborhood: results,
          linked_memories: memoryContext,
          total_connections: results.length - 1, // Exclude start node
        }

        console.log(`[Tool:query_entity_graph] Found ${results.length} nodes, ${memoryContext.length} linked memories`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
      } catch (e) {
        console.error(`[Tool:query_entity_graph] EXCEPTION:`, e)
        return { content: [{ type: 'text' as const, text: `Error querying graph: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Search Knowledge Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  // ─── get_entity_timeline — Temporal Relationship History ───────────

  const getEntityTimeline = tool(
    'get_entity_timeline',
    'View the chronological history of an entity\'s relationship changes. Shows when relationships were created, modified, or ended. Use for "What changed?" or "When did we first learn about X?" queries.',
    {
      entity_name: z.string().describe('Name of the entity to get timeline for'),
      entity_type: z.enum(['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process']).optional(),
      since: z.string().optional().describe('Only show events after this ISO date (e.g., "2024-01-01")'),
      limit: z.number().optional().default(20),
    },
    async (args) => {
      console.log(`[Tool:get_entity_timeline] entity="${args.entity_name}", since=${args.since}`)
      try {
        // Find the entity
        let entityQuery = supabase
          .from('entities')
          .select('id, name, entity_type, description, first_seen_at, last_seen_at, mention_count')
          .eq('org_id', orgId)
          .ilike('canonical_name', `%${args.entity_name.toLowerCase().trim()}%`)

        if (args.entity_type) entityQuery = entityQuery.eq('entity_type', args.entity_type)

        const { data: entities } = await entityQuery.limit(1)

        if (!entities || entities.length === 0) {
          return { content: [{ type: 'text' as const, text: `No entity found matching "${args.entity_name}".` }] }
        }

        const entity = entities[0]

        // Get the timeline using the RPC function
        const { data: timeline, error } = await supabase.rpc('get_entity_timeline', {
          p_entity_id: entity.id,
          p_org_id: orgId,
          p_since: args.since ?? null,
        })

        if (error) {
          return { content: [{ type: 'text' as const, text: `Timeline error: ${error.message}` }] }
        }

        const events = (timeline || []).slice(0, args.limit)

        const response = {
          entity: {
            name: entity.name,
            type: entity.entity_type,
            description: entity.description,
            first_seen: entity.first_seen_at,
            last_seen: entity.last_seen_at,
            total_mentions: entity.mention_count,
          },
          timeline: events,
          total_events: events.length,
        }

        console.log(`[Tool:get_entity_timeline] Found ${events.length} timeline events`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
      } catch (e) {
        console.error(`[Tool:get_entity_timeline] EXCEPTION:`, e)
        return { content: [{ type: 'text' as const, text: `Error getting timeline: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Check Entity Timeline', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  return [recallMemory, storeMemory, updateMemory, queryEntityGraph, getEntityTimeline]
}
