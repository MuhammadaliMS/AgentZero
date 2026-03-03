import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Database, Json } from '@/types/database'
import { trackActionResolvedAfterNudge } from '@/lib/intelligence/feedback-tracker'

type Commitment = Database['public']['Tables']['commitments']['Row']
type Action = Database['public']['Tables']['actions']['Row']

export function createSupabaseTools(orgId: string, conversationId?: string | null) {
  const supabase = createAdminClient()

  const queryCommitments = tool(
    'query_commitments',
    'Query commitments for the organization. Can filter by status, priority, owner, or due date.',
    {
      status: z.enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      limit: z.number().optional().default(20),
    },
    async (args) => {
      console.log(`[Tool:query_commitments] Starting: status=${args.status}, priority=${args.priority}, limit=${args.limit}`)
      try {
        let query = supabase
          .from('commitments')
          .select('*, profiles!owner_id(full_name)')
          .eq('org_id', orgId)
          .order('created_at', { ascending: false })
          .limit(args.limit)

        if (args.status) query = query.eq('status', args.status)
        if (args.priority) query = query.eq('priority', args.priority)

        const { data, error } = await query
        console.log(`[Tool:query_commitments] Result: data=${data?.length ?? 'null'}, error=${error?.message ?? 'none'}`)
        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        console.error(`[Tool:query_commitments] EXCEPTION:`, e)
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Query Commitments', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const createCommitment = tool(
    'create_commitment',
    'Create a new commitment to track. Use this when the user mentions something they need to follow up on or deliver.',
    {
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      due_date: z.string().optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from('commitments')
        .insert({
          org_id: orgId,
          conversation_id: conversationId ?? null,
          title: args.title,
          description: args.description,
          priority: args.priority,
          due_date: args.due_date,
          source: args.source,
          tags: args.tags,
        })
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
      const row = data as Commitment
      return { content: [{ type: 'text' as const, text: `Commitment created: ${row.title} (${row.id})` }] }
    },
    { annotations: { title: 'Create Commitment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  )

  const updateCommitment = tool(
    'update_commitment',
    'Update an existing commitment status, priority, or other fields.',
    {
      id: z.string(),
      status: z.enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      due_date: z.string().optional(),
      description: z.string().optional(),
    },
    async (args) => {
      const { id, ...updates } = args
      const updateData: Record<string, unknown> = {}
      if (updates.status) updateData.status = updates.status
      if (updates.priority) updateData.priority = updates.priority
      if (updates.due_date) updateData.due_date = updates.due_date
      if (updates.description) updateData.description = updates.description
      if (updates.status === 'completed') updateData.completed_at = new Date().toISOString()

      const { error } = await supabase
        .from('commitments')
        .update(updateData)
        .eq('id', id)
        .eq('org_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
      return { content: [{ type: 'text' as const, text: `Commitment ${id} updated.` }] }
    },
    { annotations: { title: 'Update Commitment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const queryActions = tool(
    'query_actions',
    'Query pending actions that need user approval or attention.',
    {
      status: z.enum(['pending', 'approved', 'rejected', 'deferred', 'expired']).optional().default('pending'),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      const { data, error } = await supabase
        .from('actions')
        .select('*')
        .eq('org_id', orgId)
        .eq('status', args.status)
        .order('created_at', { ascending: false })
        .limit(args.limit)

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    },
    { annotations: { title: 'Query Actions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const createAction = tool(
    'create_action',
    'Create a pending action that needs user approval. This will show up in their action queue.',
    {
      user_id: z.string(),
      type: z.string(),
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      payload: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from('actions')
        .insert({
          org_id: orgId,
          conversation_id: conversationId ?? null,
          user_id: args.user_id,
          type: args.type,
          title: args.title,
          description: args.description,
          priority: args.priority,
          payload: args.payload as Json,
        })
        .select()
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }
      const row = data as Action
      return { content: [{ type: 'text' as const, text: `Action created: ${row.title} (${row.id})` }] }
    },
    { annotations: { title: 'Create Action', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  )

  const resolveAction = tool(
    'resolve_action',
    'Resolve a pending action by approving, rejecting, or deferring it.',
    {
      id: z.string(),
      status: z.enum(['approved', 'rejected', 'deferred']),
      resolved_by: z.string().optional(),
    },
    async (args) => {
      const { error } = await supabase
        .from('actions')
        .update({
          status: args.status,
          resolved_at: new Date().toISOString(),
          resolved_by: args.resolved_by,
        })
        .eq('id', args.id)
        .eq('org_id', orgId)

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }

      // Track feedback signal: if a nudge existed for this action, record it
      if (args.status === 'approved' || args.status === 'rejected') {
        try {
          const userId = args.resolved_by ?? ''
          if (userId) {
            await trackActionResolvedAfterNudge(supabase, orgId, userId, args.id)
          }
        } catch {
          // Non-critical — don't fail the action resolve
        }
      }

      return { content: [{ type: 'text' as const, text: `Action ${args.id} ${args.status}.` }] }
    },
    { annotations: { title: 'Resolve Action', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  return [queryCommitments, createCommitment, updateCommitment, queryActions, createAction, resolveAction]
}
