import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/types/database'

type Memory = Database['public']['Tables']['memory']['Row']

export function createMemoryTools(orgId: string) {
  const supabase = createAdminClient()

  const recallMemory = tool(
    'recall_memory',
    'Search institutional memory for relevant context. Use this to recall past decisions, preferences, relationships, or facts about the organization.',
    {
      query: z.string().describe('Search query to find relevant memories'),
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact']).optional(),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      console.log(`[Tool:recall_memory] Starting with query="${args.query}", category=${args.category}, limit=${args.limit}`)
      try {
        let query = supabase
          .from('memory')
          .select('*')
          .eq('org_id', orgId)
          .order('confidence', { ascending: false })
          .limit(args.limit)

        if (args.category) query = query.eq('category', args.category)

        // Full-text search
        query = query.textSearch('subject', args.query, { type: 'websearch' })

        const { data, error } = await query
        console.log(`[Tool:recall_memory] Full-text result: data=${data?.length ?? 'null'}, error=${error?.message ?? 'none'}`)
        if (error) {
          // Fallback to ilike search if full-text fails
          const { data: fallbackData, error: fallbackError } = await supabase
            .from('memory')
            .select('*')
            .eq('org_id', orgId)
            .or(`subject.ilike.%${args.query}%,content.ilike.%${args.query}%`)
            .limit(args.limit)

          console.log(`[Tool:recall_memory] Fallback result: data=${fallbackData?.length ?? 'null'}, error=${fallbackError?.message ?? 'none'}`)
          return { content: [{ type: 'text' as const, text: JSON.stringify(fallbackData || [], null, 2) }] }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        console.error(`[Tool:recall_memory] EXCEPTION:`, e)
        return { content: [{ type: 'text' as const, text: `Error recalling memory: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Recall Memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const storeMemory = tool(
    'store_memory',
    'Store a new piece of institutional memory. Use this when the user shares important context, makes a decision, or reveals a preference.',
    {
      category: z.enum(['decision', 'context', 'preference', 'relationship', 'fact']),
      subject: z.string(),
      content: z.string(),
      source: z.string().optional(),
      confidence: z.number().min(0).max(1).optional().default(1.0),
      related_entities: z.array(z.string()).optional(),
    },
    async (args) => {
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
      return { content: [{ type: 'text' as const, text: `Memory stored: ${mem.subject} (${mem.id})` }] }
    },
    { annotations: { title: 'Store Memory', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  )

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

  return [recallMemory, storeMemory, updateMemory]
}
