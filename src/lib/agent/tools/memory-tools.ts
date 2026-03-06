import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, isOpenAIConfigured } from '@/lib/openai/client'
import { trackUtilityEventBatch, bumpEntityAccess } from '@/lib/graph/utility-tracker'
import { persistDecisionCard, type DecisionCardTriggerType } from '@/lib/agent/reasoning/decision-card'
import type { Database } from '@/types/database'

type Memory = Database['public']['Tables']['memory']['Row']

export function createMemoryTools(orgId: string, conversationId?: string | null) {
  const supabase = createAdminClient()

  // ─── recall_memory — Hybrid Search (text + vector + graph) ─────────

  const recallMemory = tool(
    'recall_memory',
    'Search institutional memory for relevant context. Uses hybrid search combining full-text, semantic similarity, and knowledge graph traversal for comprehensive recall.',
    {
      query: z.string().describe('Search query to find relevant memories'),
      category: z.enum([
        'decision', 'context', 'preference', 'relationship', 'fact',
        'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline',
      ]).optional(),
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
                p_category: args.category ?? undefined,
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
            // Find entities matching the query — include attributes (email, role, etc.)
            const { data: matchingEntities } = await supabase
              .from('entities')
              .select('id, name, entity_type, attributes')
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

        // ── Enrich with entity attributes (email, role, etc.) ──────
        // When recalling about a person/entity, include their stored attributes
        let entityProfiles: Array<{ name: string; type: string; attributes: Record<string, unknown> }> = []
        if (args.include_graph_context) {
          const { data: matchedEntities } = await supabase
            .from('entities')
            .select('id, name, entity_type, attributes')
            .eq('org_id', orgId)
            .or(`name.ilike.%${args.query}%,canonical_name.ilike.%${args.query.toLowerCase()}%`)
            .limit(5)
          if (matchedEntities && matchedEntities.length > 0) {
            const entityIds = matchedEntities.map(e => e.id)
            trackUtilityEventBatch(orgId, entityIds, 'retrieved').catch(() => {})
            bumpEntityAccess(orgId, entityIds).catch(() => {})
            // Include entities that have non-empty attributes (email, role, phone, etc.)
            entityProfiles = matchedEntities
              .filter(e => e.attributes && Object.keys(e.attributes as Record<string, unknown>).length > 0)
              .map(e => ({
                name: e.name,
                type: e.entity_type,
                attributes: e.attributes as Record<string, unknown>,
              }))
          }
        }

        const response: Record<string, unknown> = { memories: ranked }
        if (entityProfiles.length > 0) {
          response.entity_profiles = entityProfiles
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
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
    `Store or update institutional memory. Call this FREQUENTLY — every conversation should produce at least one memory.

**ALWAYS store when you learn about:**
- Tasks, action items, or follow-ups (category: task)
- Project status or progress updates (category: project_status)
- Meeting outcomes or key takeaways (category: meeting_outcome)
- Blockers or issues raised (category: blocker)
- Deadlines or important dates (category: deadline)
- People and their roles/responsibilities (category: relationship)
- Decisions made (category: decision)
- User preferences or working style (category: preference)
- Org context and background (category: context)
- Reference facts (category: fact)

**Deduplication:** If a memory with the same subject already exists, it will be UPDATED (merged) rather than duplicated. So feel free to store aggressively — storing "Project Alpha" twice just updates it with the latest info.`,
    {
      category: z.enum([
        'decision', 'context', 'preference', 'relationship', 'fact',
        'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline',
      ]),
      subject: z.string().describe('Short, specific label (e.g., "SOC2 audit deadline", "Sarah Chen role", "Q1 OKR status"). Use consistent naming so updates merge correctly.'),
      content: z.string().describe('Detailed information. For updates, include ALL current info — this replaces the previous content.'),
      source: z.string().optional().describe('Where this info came from (e.g., "user conversation", "email from Sarah", "Slack #security")'),
      confidence: z.number().min(0).max(1).optional().default(1.0),
      related_entities: z.array(z.string()).optional().describe('People, projects, tools mentioned (e.g., ["Sarah Chen", "SOC2 Remediation", "Vanta"])'),
      event_date: z.string().optional().describe('ISO date of the real-world event this memory relates to (e.g., meeting date, decision date). Use when the memory is tied to a specific date.'),
    },
    async (args) => {
      try {
        // ── Duplicate detection: check if same subject exists for this org ──
        const { data: existing } = await supabase
          .from('memory')
          .select('id, content, confidence, related_entities')
          .eq('org_id', orgId)
          .ilike('subject', args.subject.trim())
          .limit(1)
          .maybeSingle()

        let mem: Memory

        if (existing) {
          // ── UPDATE existing memory (merge) ──
          const mergedEntities = [
            ...new Set([
              ...(existing.related_entities || []),
              ...(args.related_entities || []),
            ]),
          ]

          const updateData: Record<string, unknown> = {
            content: args.content,
            category: args.category,
            confidence: args.confidence,
            related_entities: mergedEntities,
            source: args.source,
            updated_at: new Date().toISOString(),
          }
          if (args.event_date) updateData.event_date = args.event_date

          const { data: updated, error } = await supabase
            .from('memory')
            .update(updateData)
            .eq('id', existing.id)
            .eq('org_id', orgId)
            .select()
            .single()

          if (error) return { content: [{ type: 'text' as const, text: `Error updating memory: ${error.message}` }] }
          mem = updated as Memory
          console.log(`[Tool:store_memory] UPDATED existing memory: "${args.subject}" (${mem.id})`)

          // Extract and upsert contact attributes on update too
          if (args.category === 'relationship' && args.related_entities?.length) {
            extractAndUpsertEntityAttributes(supabase, orgId, args.related_entities, args.content).catch(() => {})
          }

          // Re-generate embedding for updated content
          if (isOpenAIConfigured()) {
            const embeddingText = `${args.subject}: ${args.content}`
            generateEmbedding(embeddingText).then(async (embedding) => {
              if (embedding) {
                // Upsert — replace old embedding
                await supabase
                  .from('memory_embeddings')
                  .upsert(
                    { memory_id: mem.id, embedding: JSON.stringify(embedding) },
                    { onConflict: 'memory_id' }
                  )
              }
            }).catch(err => console.warn('[store_memory] Embedding update failed:', err))
          }

          return { content: [{ type: 'text' as const, text: `Memory updated (merged with existing): ${mem.subject} (${mem.id})` }] }
        }

        // ── INSERT new memory ──
        const insertData: Record<string, unknown> = {
          org_id: orgId,
          category: args.category,
          subject: args.subject,
          content: args.content,
          source: args.source,
          confidence: args.confidence,
          related_entities: args.related_entities,
        }
        if (args.event_date) insertData.event_date = args.event_date

        const { data, error } = await supabase
          .from('memory')
          .insert(insertData as never)
          .select()
          .single()

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
        mem = data as Memory
        console.log(`[Tool:store_memory] NEW memory stored: "${args.subject}" (${mem.id})`)

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

        // Background: extract contact attributes (email, phone, role, title) and upsert to entity
        if (args.category === 'relationship' && args.related_entities?.length) {
          extractAndUpsertEntityAttributes(supabase, orgId, args.related_entities, args.content).catch(() => {})
        }

        return { content: [{ type: 'text' as const, text: `Memory stored: ${mem.subject} (${mem.id})` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error storing memory: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Store Memory', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  // ─── update_memory ────────────────────────────────────────────────

  const updateMemory = tool(
    'update_memory',
    'Update an existing memory entry. Use this to adjust confidence, update content, or correct stale memories.',
    {
      id: z.string(),
      content: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      category: z.enum([
        'decision', 'context', 'preference', 'relationship', 'fact',
        'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline',
      ]).optional(),
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
    'Traverse the knowledge graph from a named entity. Shows connected people, projects, features, customers, decisions, and their relationships. Use this to explore "everything connected to X".',
    {
      entity_name: z.string().describe('Name of the entity to start from (e.g., "Sarah Chen", "Onboarding Flow")'),
      entity_type: z.enum(['person', 'project', 'feature', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process', 'customer', 'metric']).optional(),
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
          .select('id, name, entity_type, description, attributes, mention_count')
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

        // Track utility events (fire-and-forget)
        const graphEntityIds = [startEntity.id, ...(results as Array<{ entity_id?: string }>)
          .map(r => r.entity_id).filter(Boolean) as string[]]
        const uniqueEntityIds = [...new Set(graphEntityIds)]
        trackUtilityEventBatch(orgId, uniqueEntityIds, 'retrieved').catch(() => {})
        bumpEntityAccess(orgId, uniqueEntityIds).catch(() => {})

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
      entity_type: z.enum(['person', 'project', 'feature', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process', 'customer', 'metric']).optional(),
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
          p_since: args.since ?? undefined,
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

  // ─── emit_decision_card — Reasoning Substrate ───────────────────────

  const emitDecisionCard = tool(
    'emit_decision_card',
    `Record a structured decision card capturing your reasoning for a significant decision.

**When to emit a decision card:**
- You are choosing between multiple approaches or options
- You are making a strategic recommendation
- You detect a contradiction or conflict and decide how to handle it
- You escalate a risk or change priority
- You formulate a multi-step plan
- You recover from a failure or change approach mid-conversation

**Do NOT emit for trivial decisions** like choosing formatting or recalling a single fact.`,
    {
      trigger_type: z.enum([
        'user_turn',
        'proactive_signal',
        'contradiction',
        'planning',
        'escalation',
        'recovery',
      ]).describe('What triggered this decision'),
      objective: z.string().describe('What you are trying to achieve with this decision'),
      context_summary: z.string().optional().describe('Brief relevant background for this decision'),
      options_considered: z.array(z.object({
        option: z.string(),
        pros: z.array(z.string()).optional(),
        cons: z.array(z.string()).optional(),
        rejected_reason: z.string().optional(),
      })).optional().describe('Options you evaluated (include at least 2 when applicable)'),
      chosen_action: z.string().describe('What you decided to do'),
      confidence: z.number().min(0).max(1).describe('How confident you are in this decision (0-1)'),
      why_now: z.string().optional().describe('Why this decision matters at this moment'),
      risk_notes: z.string().optional().describe('Known risks or caveats with this choice'),
      related_entities: z.array(z.string()).optional().describe('Entity names involved in this decision'),
    },
    async (args) => {
      console.log(`[Tool:emit_decision_card] trigger=${args.trigger_type} objective="${args.objective.slice(0, 60)}"`)
      try {
        const cardId = await persistDecisionCard({
          orgId,
          conversationId: conversationId ?? undefined,
          triggerType: args.trigger_type as DecisionCardTriggerType,
          triggerSource: 'chat',
          objective: args.objective,
          contextSummary: args.context_summary,
          optionsConsidered: args.options_considered,
          chosenAction: args.chosen_action,
          confidence: args.confidence,
          whyNow: args.why_now,
          riskNotes: args.risk_notes,
          relatedEntityIds: [], // Entity name resolution deferred — entities linked by name in graph
          relatedInsightIds: [],
        })

        if (!cardId) {
          return { content: [{ type: 'text' as const, text: 'Decision card recorded (persistence pending).' }] }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Decision card recorded (${cardId}). Objective: ${args.objective}. Action: ${args.chosen_action}. Confidence: ${args.confidence}.`,
          }],
        }
      } catch (e) {
        console.error('[Tool:emit_decision_card] EXCEPTION:', e)
        return { content: [{ type: 'text' as const, text: `Decision card noted (error persisting: ${(e as Error).message}).` }] }
      }
    },
    { annotations: { title: 'Decision Card', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  )

  // ─── delete_memory ──────────────────────────────────────────────────

  const deleteMemory = tool(
    'delete_memory',
    'Delete a memory entry that is outdated, incorrect, or no longer relevant. Use after recalling memories to clean up stale information. Also deletes associated embeddings.',
    {
      id: z.string().describe('Memory ID to delete'),
      reason: z.string().optional().describe('Brief reason for deletion (for audit trail)'),
    },
    async (args) => {
      try {
        const { data: existing } = await supabase
          .from('memory')
          .select('id, subject')
          .eq('id', args.id)
          .eq('org_id', orgId)
          .maybeSingle()
        if (!existing) return { content: [{ type: 'text' as const, text: `Memory ${args.id} not found or does not belong to this organization.` }] }

        await supabase.from('memory_embeddings').delete().eq('memory_id', args.id)
        await supabase.from('memory_entity_links').delete().eq('memory_id', args.id)
        const { error } = await supabase.from('memory').delete().eq('id', args.id).eq('org_id', orgId)
        if (error) return { content: [{ type: 'text' as const, text: `Error deleting memory: ${error.message}` }] }

        console.log(`[Memory] Deleted memory "${existing.subject}" (${args.id}). Reason: ${args.reason ?? 'not specified'}`)
        return { content: [{ type: 'text' as const, text: `Memory deleted: "${existing.subject}" (${args.id})` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Delete Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }
  )

  // ─── list_entities — Knowledge Graph Entity Search ─────────────────

  const listEntities = tool(
    'list_entities',
    'List and search entities in the knowledge graph. Returns people, projects, features, customers, metrics, decisions, teams, tools, vendors, and other entities. Use to discover what the organization knows about.',
    {
      search: z.string().optional().describe('Optional search term to filter entities by name'),
      entity_type: z.enum(['person', 'project', 'feature', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process', 'customer', 'metric']).optional(),
      limit: z.number().optional().default(20),
    },
    async (args) => {
      try {
        let q = supabase
          .from('entities')
          .select('id, name, entity_type, attributes, mention_count, first_seen_at, last_seen_at')
          .eq('org_id', orgId)
          .order('mention_count', { ascending: false })
          .limit(Math.min(args.limit ?? 20, 50))

        if (args.entity_type) q = q.eq('entity_type', args.entity_type)
        if (args.search) q = q.or(`name.ilike.%${args.search}%,canonical_name.ilike.%${args.search.toLowerCase()}%`)

        const { data, error } = await q
        if (error) return { content: [{ type: 'text' as const, text: `Error listing entities: ${error.message}` }] }
        if (!data || data.length === 0) return { content: [{ type: 'text' as const, text: 'No entities found matching the criteria.' }] }

        return { content: [{ type: 'text' as const, text: JSON.stringify((data as Array<Record<string, unknown>>).map(e => ({
          id: e.id,
          name: e.name,
          type: e.entity_type,
          mentions: e.mention_count,
          first_seen: e.first_seen_at,
          last_seen: e.last_seen_at,
        })), null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'List Entities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  // ─── Strategic Narrative Tools ─────────────────────────────────────

  const listNarratives = tool(
    'list_narratives',
    'List active strategic narratives — ongoing initiatives, political context, decision threads, risk threads, and relationship dynamics. These are high-level organizational context the agent tracks over time.',
    {
      narrative_type: z.enum(['initiative', 'political_context', 'decision_thread', 'risk_thread', 'relationship_dynamic']).optional(),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      try {
        const { getActiveNarratives } = await import('@/lib/graph/strategic-memory')
        const narratives = await getActiveNarratives(orgId, {
          narrativeType: args.narrative_type,
          limit: args.limit ?? 10,
        })
        if (narratives.length === 0) return { content: [{ type: 'text' as const, text: 'No active strategic narratives found.' }] }
        return { content: [{ type: 'text' as const, text: JSON.stringify(narratives.map(n => ({
          id: n.id, title: n.title, type: n.narrativeType, status: n.status,
          summary: n.summary, keyFacts: n.keyFacts.length, openQuestions: n.openQuestions.length,
          promotionScore: n.promotionScore, updatedAt: n.updatedAt,
        })), null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'List Narratives', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const getNarrative = tool(
    'get_narrative',
    'Get full details of a specific strategic narrative including key facts, decision history, prior outcomes, and open questions.',
    {
      narrative_id: z.string().describe('ID of the narrative to retrieve'),
    },
    async (args) => {
      try {
        const { data, error } = await supabase
          .from('strategic_narratives')
          .select('*')
          .eq('id', args.narrative_id)
          .eq('org_id', orgId)
          .maybeSingle()

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
        if (!data) return { content: [{ type: 'text' as const, text: `Narrative ${args.narrative_id} not found.` }] }

        return { content: [{ type: 'text' as const, text: JSON.stringify({
          id: data.id, title: data.title, type: data.narrative_type, status: data.status,
          summary: data.summary, keyFacts: data.key_facts, decisionHistory: data.decision_history,
          priorOutcomes: data.prior_outcomes, openQuestions: data.open_questions,
          relatedEntityIds: data.related_entity_ids, promotionScore: data.promotion_score,
          updatedAt: data.updated_at, createdAt: data.created_at,
        }, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Get Narrative', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const upsertNarrativeTool = tool(
    'upsert_narrative',
    'Create or update a strategic narrative. Narratives capture ongoing organizational context that persists across conversations — initiatives, political dynamics, decision threads, risk threads, and relationship dynamics. Auto-deduplicates on title + type.',
    {
      title: z.string().describe('Descriptive title (e.g., "SOC2 Audit Push", "CTO Succession Planning")'),
      narrative_type: z.enum(['initiative', 'political_context', 'decision_thread', 'risk_thread', 'relationship_dynamic']),
      summary: z.string().describe('Current state summary of this narrative thread'),
      key_facts: z.array(z.object({
        fact: z.string(),
        source: z.string().optional(),
        confidence: z.number().optional(),
      })).optional(),
      decision_history: z.array(z.object({
        decision: z.string(),
        date: z.string().optional(),
        outcome: z.string().optional(),
        lesson: z.string().optional(),
      })).optional(),
      open_questions: z.array(z.object({
        question: z.string(),
        context: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
      })).optional(),
      related_entity_ids: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const { upsertNarrative } = await import('@/lib/graph/strategic-memory')
        const narrativeId = await upsertNarrative({
          orgId,
          title: args.title,
          narrativeType: args.narrative_type,
          summary: args.summary,
          keyFacts: args.key_facts ?? [],
          decisionHistory: args.decision_history ?? [],
          openQuestions: args.open_questions ?? [],
          relatedEntityIds: args.related_entity_ids ?? [],
          lastUpdatedBy: 'agent',
        })

        if (!narrativeId) return { content: [{ type: 'text' as const, text: 'Failed to create/update narrative.' }] }
        return { content: [{ type: 'text' as const, text: `Narrative saved: "${args.title}" (${narrativeId})` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Save Narrative', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  return [
    recallMemory, storeMemory, updateMemory, deleteMemory,
    queryEntityGraph, getEntityTimeline, listEntities,
    listNarratives, getNarrative, upsertNarrativeTool,
    emitDecisionCard,
  ]
}

// ─── Helper: Extract contact attributes from memory content and upsert to entity ───
async function extractAndUpsertEntityAttributes(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entityNames: string[],
  content: string,
) {
  // Extract common contact attributes from the content
  const extractedAttrs: Record<string, string> = {}

  // Email
  const emailMatch = content.match(/[\w.+-]+@[\w-]+\.[\w.]+/i)
  if (emailMatch) extractedAttrs.email = emailMatch[0].toLowerCase()

  // Phone
  const phoneMatch = content.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/)
  if (phoneMatch) extractedAttrs.phone = phoneMatch[0]

  // Title/Role (common patterns)
  const titleMatch = content.match(/(?:title|role|position|designation)[:\s]+["']?([^"'\n,]+)/i)
  if (titleMatch) extractedAttrs.title = titleMatch[1].trim()

  // Company/Organization
  const companyMatch = content.match(/(?:company|org|organization|works at|from)[:\s]+["']?([^"'\n,]+)/i)
  if (companyMatch) extractedAttrs.company = companyMatch[1].trim()

  if (Object.keys(extractedAttrs).length === 0) return

  // For each related entity, try to find and update their attributes
  for (const entityName of entityNames) {
    const { data: entity } = await supabase
      .from('entities')
      .select('id, attributes')
      .eq('org_id', orgId)
      .ilike('canonical_name', entityName.toLowerCase().trim())
      .limit(1)
      .maybeSingle()

    if (entity) {
      const existingAttrs = (entity.attributes as Record<string, unknown>) || {}
      const mergedAttrs = { ...existingAttrs, ...extractedAttrs }

      await supabase
        .from('entities')
        .update({ attributes: mergedAttrs as unknown as Record<string, never> })
        .eq('id', entity.id)

      console.log(`[store_memory] Upserted entity attributes for "${entityName}":`, extractedAttrs)
    }
  }
}
