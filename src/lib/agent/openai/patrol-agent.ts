/**
 * OpenAI Agents SDK — Patrol Analyst Agent
 *
 * A background agent that scans connected integrations (email, Slack, calendar, Vanta),
 * correlates signals with DB state, discovers new commitments, and produces structured findings.
 *
 * Runs independently from the Captain (Claude Agent SDK) — different framework, different model.
 */

import { Agent, Runner, tool } from '@openai/agents'
import { OpenAIProvider, setOpenAIAPI } from '@openai/agents'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, isOpenAIConfigured } from '@/lib/openai/client'
import { WebClient } from '@slack/web-api'
import type { WorkerViews } from '@/lib/intelligence/brief-synthesizer'

// ─── RunContext ──────────────────────────────────────────────────────────────

export interface PatrolContext {
  orgId: string
  userId: string
  connectedIntegrations: string[] // ['gmail', 'slack', 'google_calendar', 'vanta']
}

// ─── Structured Output Schema ────────────────────────────────────────────────

export const PatrolFindingsSchema = z.object({
  findings: z.array(
    z.object({
      type: z.enum([
        'cross_signal_risk',
        'discovered_commitment',
        'integration_insight',
        'compliance_gap',
        'stakeholder_signal',
        'deadline_conflict',
      ]),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      title: z.string(),
      description: z.string(),
      source_integrations: z.array(z.string()),
      entity_name: z.string().optional(),
      commitment_id: z.string().optional(),
    })
  ),
  summary: z.string(),
})

export type PatrolFindings = z.infer<typeof PatrolFindingsSchema>

// ─── Helper: Strip HTML ──────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Tool Definitions ────────────────────────────────────────────────────────
// Each tool receives orgId from the agent's system prompt context (passed inline).
// We create tools as a function that closes over orgId.

export function createPatrolTools(orgId: string) {
  const supabase = createAdminClient()

  // ── READ: Recent Emails ──────────────────────────────────────────────────

  const readRecentEmails = tool({
    name: 'read_recent_emails',
    description:
      'Fetch recent emails (last 24h) with subjects, senders, dates, and snippets. Use to discover commitments, deadlines, and action items from email.',
    parameters: z.object({
      max_results: z.number().optional().default(15),
      query: z.string().optional().describe('Gmail search query (e.g., "is:unread", "subject:deadline")'),
    }),
    execute: async (args) => {
      // Try Gmail first, then Outlook
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        try {
          const q = args.query || 'newer_than:1d'
          const listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.max_results}&q=${encodeURIComponent(q)}`,
            { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
          )
          const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
          if (listData.error) return `Gmail API error: ${listData.error.message}`
          if (!listData.messages?.length) return 'No emails found matching query.'

          const emails = await Promise.all(
            listData.messages.slice(0, args.max_results).map(async (msg) => {
              const detailRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`,
                { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
              )
              const detail = (await detailRes.json()) as {
                id: string
                snippet: string
                payload?: { headers?: Array<{ name: string; value: string }> }
              }
              const headers = detail.payload?.headers ?? []
              const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
              return {
                id: detail.id,
                subject: getHeader('Subject'),
                from: getHeader('From'),
                date: getHeader('Date'),
                snippet: detail.snippet,
              }
            })
          )

          return JSON.stringify(emails, null, 2)
        } catch (e) {
          return `Gmail error: ${(e as Error).message}`
        }
      }

      // Try Outlook
      const outlookTokens = await TokenManager.getTokens(orgId, 'microsoft')
      if (outlookTokens) {
        try {
          const res = await fetch(
            `https://graph.microsoft.com/v1.0/me/messages?$top=${args.max_results}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview`,
            { headers: { Authorization: `Bearer ${outlookTokens.access_token}` } }
          )
          const data = (await res.json()) as { value?: Array<Record<string, unknown>>; error?: { message: string } }
          if (data.error) return `Outlook API error: ${data.error.message}`
          return JSON.stringify(data.value ?? [], null, 2)
        } catch (e) {
          return `Outlook error: ${(e as Error).message}`
        }
      }

      return 'No email integration connected — skip email scanning.'
    },
  })

  // ── READ: Search Emails ──────────────────────────────────────────────────

  const searchEmails = tool({
    name: 'search_emails',
    description:
      'Search emails with a specific query. Use for targeted searches like "deadline", "action required", "follow up".',
    parameters: z.object({
      query: z.string().describe('Search query (e.g., "action required", "deadline this week")'),
      max_results: z.number().optional().default(10),
    }),
    execute: async (args) => {
      const gmailTokens = await TokenManager.getTokens(orgId, 'gmail')
      if (gmailTokens) {
        try {
          const listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.max_results}&q=${encodeURIComponent(args.query)}`,
            { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
          )
          const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; error?: { message: string } }
          if (listData.error) return `Gmail search error: ${listData.error.message}`
          if (!listData.messages?.length) return `No emails found for query: "${args.query}"`

          const emails = await Promise.all(
            listData.messages.slice(0, args.max_results).map(async (msg) => {
              const detailRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                { headers: { Authorization: `Bearer ${gmailTokens.access_token}` } }
              )
              const detail = (await detailRes.json()) as {
                id: string
                snippet: string
                payload?: { headers?: Array<{ name: string; value: string }> }
              }
              const headers = detail.payload?.headers ?? []
              const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
              return {
                id: detail.id,
                subject: getHeader('Subject'),
                from: getHeader('From'),
                date: getHeader('Date'),
                snippet: detail.snippet,
              }
            })
          )

          return JSON.stringify(emails, null, 2)
        } catch (e) {
          return `Gmail search error: ${(e as Error).message}`
        }
      }

      return 'No email integration connected — skip email search.'
    },
  })

  // ── READ: Slack Mentions ─────────────────────────────────────────────────

  const getSlackMentions = tool({
    name: 'get_slack_mentions',
    description:
      'Get recent Slack @mentions and unread DMs. Use to discover follow-ups, questions directed at the team, and blockers.',
    parameters: z.object({
      hours_back: z.number().optional().default(24),
    }),
    execute: async (args) => {
      const tokens = await TokenManager.getTokens(orgId, 'slack')
      if (!tokens) return 'Slack not connected — skip Slack scanning.'

      const client = new WebClient(tokens.user_access_token || tokens.access_token)

      try {
        const results: Array<Record<string, unknown>> = []

        // Search for recent mentions
        const searchRes = await client.search.messages({
          query: `to:me after:${Math.floor((Date.now() - args.hours_back * 3600_000) / 1000)}`,
          count: 20,
          sort: 'timestamp',
          sort_dir: 'desc',
        })

        if (searchRes.messages?.matches) {
          for (const match of searchRes.messages.matches.slice(0, 15)) {
            results.push({
              channel: match.channel?.name ?? 'unknown',
              from: match.username ?? 'unknown',
              text: match.text?.substring(0, 300),
              ts: match.ts,
              permalink: match.permalink,
            })
          }
        }

        return results.length > 0
          ? JSON.stringify(results, null, 2)
          : 'No recent mentions or DMs found.'
      } catch (e) {
        return `Slack mentions error: ${(e as Error).message}`
      }
    },
  })

  // ── READ: Slack Channel ──────────────────────────────────────────────────

  const readSlackChannel = tool({
    name: 'read_slack_channel',
    description:
      'Read recent messages from a specific Slack channel. Use to scan key project channels for updates, decisions, and blockers.',
    parameters: z.object({
      channel_id: z.string().describe('Slack channel ID (e.g., C01ABCDEF)'),
      limit: z.number().optional().default(20),
    }),
    execute: async (args) => {
      const tokens = await TokenManager.getTokens(orgId, 'slack')
      if (!tokens) return 'Slack not connected — skip channel reading.'

      const client = new WebClient(tokens.user_access_token || tokens.access_token)

      try {
        const res = await client.conversations.history({
          channel: args.channel_id,
          limit: args.limit,
        })

        if (!res.messages?.length) return 'No messages found in channel.'

        // Resolve user names in parallel
        const userIds = [...new Set(res.messages.map((m) => m.user).filter(Boolean) as string[])]
        const userMap = new Map<string, string>()
        await Promise.all(
          userIds.map(async (uid) => {
            try {
              const info = await client.users.info({ user: uid })
              userMap.set(uid, info.user?.real_name || info.user?.name || uid)
            } catch {
              userMap.set(uid, uid)
            }
          })
        )

        const messages = res.messages.map((m) => ({
          from: userMap.get(m.user ?? '') ?? m.user ?? 'unknown',
          text: m.text?.substring(0, 400),
          ts: m.ts,
          thread_ts: m.thread_ts,
          reply_count: (m as Record<string, unknown>).reply_count ?? 0,
        }))

        return JSON.stringify(messages, null, 2)
      } catch (e) {
        return `Slack channel error: ${(e as Error).message}`
      }
    },
  })

  // ── READ: List Slack Channels ────────────────────────────────────────────

  const listSlackChannels = tool({
    name: 'list_slack_channels',
    description:
      'List available Slack channels. Use to discover which channels to scan for relevant project discussions.',
    parameters: z.object({
      limit: z.number().optional().default(50),
    }),
    execute: async (args) => {
      const tokens = await TokenManager.getTokens(orgId, 'slack')
      if (!tokens) return 'Slack not connected — skip channel listing.'

      const client = new WebClient(tokens.user_access_token || tokens.access_token)

      try {
        const res = await client.conversations.list({
          types: 'public_channel,private_channel',
          limit: args.limit,
          exclude_archived: true,
        })

        const channels = (res.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          topic: c.topic?.value?.substring(0, 100),
          purpose: c.purpose?.value?.substring(0, 100),
          num_members: c.num_members,
        }))

        return JSON.stringify(channels, null, 2)
      } catch (e) {
        return `Slack channels error: ${(e as Error).message}`
      }
    },
  })

  // ── READ: Today's Calendar Events ────────────────────────────────────────

  const getTodayEvents = tool({
    name: 'get_today_events',
    description:
      "Get today's and tomorrow's calendar events. Use to detect deadline conflicts, meeting prep needs, and scheduling patterns.",
    parameters: z.object({
      days_ahead: z.number().optional().default(2),
    }),
    execute: async (args) => {
      const now = new Date()
      const startOfDay = new Date(now)
      startOfDay.setHours(0, 0, 0, 0)
      const endOfRange = new Date(startOfDay)
      endOfRange.setDate(endOfRange.getDate() + args.days_ahead)

      // Try Google Calendar
      const googleTokens = await TokenManager.getTokens(orgId, 'google_calendar')
      if (googleTokens) {
        try {
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${startOfDay.toISOString()}&timeMax=${endOfRange.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=30`,
            { headers: { Authorization: `Bearer ${googleTokens.access_token}` } }
          )
          const data = (await res.json()) as { items?: Array<Record<string, unknown>>; error?: { message: string } }
          if (data.error) return `Google Calendar error: ${data.error.message}`

          const events = (data.items ?? []).map((e) => ({
            summary: e.summary,
            start: (e.start as Record<string, unknown>)?.dateTime || (e.start as Record<string, unknown>)?.date,
            end: (e.end as Record<string, unknown>)?.dateTime || (e.end as Record<string, unknown>)?.date,
            location: e.location,
            description: typeof e.description === 'string' ? e.description.substring(0, 200) : undefined,
            attendees: Array.isArray(e.attendees)
              ? (e.attendees as Array<{ email: string }>).map((a) => a.email).slice(0, 5)
              : [],
          }))

          return JSON.stringify(events, null, 2)
        } catch (e) {
          return `Google Calendar error: ${(e as Error).message}`
        }
      }

      // Try Microsoft Calendar
      const msTokens = await TokenManager.getTokens(orgId, 'microsoft')
      if (msTokens) {
        try {
          const res = await fetch(
            `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${startOfDay.toISOString()}&endDateTime=${endOfRange.toISOString()}&$orderby=start/dateTime&$top=30&$select=subject,start,end,location,bodyPreview,attendees`,
            {
              headers: {
                Authorization: `Bearer ${msTokens.access_token}`,
                Prefer: 'outlook.timezone="UTC"',
              },
            }
          )
          const data = (await res.json()) as { value?: Array<Record<string, unknown>>; error?: { message: string } }
          if (data.error) return `Microsoft Calendar error: ${data.error.message}`
          return JSON.stringify(data.value ?? [], null, 2)
        } catch (e) {
          return `Microsoft Calendar error: ${(e as Error).message}`
        }
      }

      return 'No calendar integration connected — skip calendar scanning.'
    },
  })

  // ── READ: Compliance Overview ────────────────────────────────────────────

  const getComplianceOverview = tool({
    name: 'get_compliance_overview',
    description:
      'Get compliance posture from Vanta — health score, failing controls, and frameworks. Use to cross-reference with commitments.',
    parameters: z.object({}),
    execute: async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) return 'Vanta not connected — skip compliance scanning.'

      try {
        const res = await fetch('https://api.vanta.com/v1/resources/controls', {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: 'application/json',
          },
        })
        const data = (await res.json()) as {
          results?: {
            data?: Array<{
              name?: string
              monitorStatus?: string
              controlFrameworks?: Array<{ name?: string }>
              severity?: string
            }>
          }
          error?: string
        }

        if (data.error) return `Vanta API error: ${data.error}`

        const controls = data.results?.data ?? []
        const total = controls.length
        const byStatus: Record<string, number> = {}
        const failing: Array<{ name: string; status: string; severity: string }> = []
        const frameworks = new Set<string>()

        for (const c of controls) {
          const status = c.monitorStatus ?? 'UNKNOWN'
          byStatus[status] = (byStatus[status] ?? 0) + 1
          if (['FAILING', 'AT_RISK', 'DISABLED', 'NEEDS_ATTENTION'].includes(status)) {
            failing.push({
              name: c.name ?? 'Unknown',
              status,
              severity: c.severity ?? 'unknown',
            })
          }
          for (const fw of c.controlFrameworks ?? []) {
            if (fw.name) frameworks.add(fw.name)
          }
        }

        const passing = byStatus['IN_PLACE'] ?? 0
        const healthScore = total > 0 ? Math.round((passing / total) * 100) : 0

        return JSON.stringify(
          {
            health_score: healthScore,
            total_controls: total,
            status_breakdown: byStatus,
            failing_controls: failing.slice(0, 10),
            frameworks: Array.from(frameworks),
          },
          null,
          2
        )
      } catch (e) {
        return `Vanta error: ${(e as Error).message}`
      }
    },
  })

  // ── READ: Query Commitments (DB) ─────────────────────────────────────────

  const queryCommitments = tool({
    name: 'query_commitments',
    description:
      'Query tracked commitments from the database. Filter by status and priority. Always check before creating to avoid duplicates.',
    parameters: z.object({
      status: z
        .enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled'])
        .optional()
        .describe('Filter by status'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      limit: z.number().optional().default(20),
    }),
    execute: async (args) => {
      let query = supabase
        .from('commitments')
        .select('id, title, description, status, priority, due_date, risk_score, tags, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(args.limit)

      if (args.status) query = query.eq('status', args.status)
      if (args.priority) query = query.eq('priority', args.priority)

      const { data, error } = await query
      if (error) return `DB error: ${error.message}`
      return JSON.stringify(data, null, 2)
    },
  })

  // ── READ: Recall Memory (DB) ─────────────────────────────────────────────

  const recallMemory = tool({
    name: 'recall_memory',
    description:
      'Search institutional memory for relevant context. Uses text search + semantic similarity. Always recall before storing to check for duplicates.',
    parameters: z.object({
      query: z.string().describe('Search query'),
      category: z
        .enum([
          'decision',
          'context',
          'preference',
          'relationship',
          'fact',
          'task',
          'meeting_outcome',
          'project_status',
          'blocker',
          'deadline',
        ])
        .optional(),
      limit: z.number().optional().default(10),
    }),
    execute: async (args) => {
      // Full-text search
      let query = supabase
        .from('memory')
        .select('id, subject, content, category, confidence, related_entities, created_at')
        .eq('org_id', orgId)
        .textSearch('subject', args.query, { type: 'websearch' })
        .order('confidence', { ascending: false })
        .limit(args.limit)

      if (args.category) query = query.eq('category', args.category)

      const { data: textData } = await query

      // Vector search if available
      let vectorData: Array<Record<string, unknown>> | null = null
      if (isOpenAIConfigured()) {
        try {
          const embedding = await generateEmbedding(args.query)
          if (embedding) {
            const { data: vd } = await supabase.rpc('search_memories_by_embedding', {
              p_org_id: orgId,
              p_embedding: JSON.stringify(embedding),
              p_limit: args.limit,
              p_category: args.category ?? null,
            })
            vectorData = vd as Array<Record<string, unknown>> | null
          }
        } catch {
          // Vector search is optional
        }
      }

      // Merge results — text first, then vector-only
      const seenIds = new Set<string>()
      const merged: Array<Record<string, unknown>> = []

      for (const mem of textData ?? []) {
        seenIds.add(mem.id)
        merged.push({ ...mem, _source: 'text' })
      }

      if (vectorData) {
        for (const vm of vectorData) {
          const memId = vm.memory_id as string
          if (!seenIds.has(memId)) {
            seenIds.add(memId)
            merged.push({ ...vm, _source: 'vector' })
          }
        }
      }

      // Fallback ilike if nothing found
      if (merged.length === 0) {
        const { data: fallback } = await supabase
          .from('memory')
          .select('id, subject, content, category, confidence, related_entities, created_at')
          .eq('org_id', orgId)
          .or(`subject.ilike.%${args.query}%,content.ilike.%${args.query}%`)
          .limit(args.limit)

        if (fallback) {
          for (const mem of fallback) {
            merged.push({ ...mem, _source: 'ilike' })
          }
        }
      }

      return merged.length > 0 ? JSON.stringify(merged, null, 2) : 'No memories found matching query.'
    },
  })

  // ── WRITE: Store Memory (DB) ─────────────────────────────────────────────

  const storeMemory = tool({
    name: 'store_memory',
    description:
      'Store or update institutional memory. Deduplicates on subject — storing the same subject updates it. Use for patterns, decisions, relationships discovered during scan.',
    parameters: z.object({
      category: z.enum([
        'decision',
        'context',
        'preference',
        'relationship',
        'fact',
        'task',
        'meeting_outcome',
        'project_status',
        'blocker',
        'deadline',
      ]),
      subject: z.string().describe('Short label (e.g., "SOC2 audit deadline", "Sarah Chen role")'),
      content: z.string().describe('Detailed information'),
      source: z.string().optional().describe('Where this info came from (e.g., "email from Sarah", "Slack #security")'),
      related_entities: z.array(z.string()).optional().describe('People, projects, tools mentioned'),
    }),
    execute: async (args) => {
      // Dedup check
      const { data: existing } = await supabase
        .from('memory')
        .select('id, content, related_entities')
        .eq('org_id', orgId)
        .ilike('subject', args.subject.trim())
        .limit(1)
        .maybeSingle()

      if (existing) {
        const mergedEntities = [
          ...new Set([...(existing.related_entities || []), ...(args.related_entities || [])]),
        ]

        const { error } = await supabase
          .from('memory')
          .update({
            content: args.content,
            category: args.category,
            related_entities: mergedEntities,
            source: args.source,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .eq('org_id', orgId)

        if (error) return `Error updating memory: ${error.message}`

        // Background: re-generate embedding
        if (isOpenAIConfigured()) {
          generateEmbedding(`${args.subject}: ${args.content}`)
            .then(async (emb) => {
              if (emb) {
                await supabase
                  .from('memory_embeddings')
                  .upsert({ memory_id: existing.id, embedding: JSON.stringify(emb) }, { onConflict: 'memory_id' })
              }
            })
            .catch(() => {})
        }

        return `Memory updated (merged): ${args.subject} (${existing.id})`
      }

      // New insert
      const { data, error } = await supabase
        .from('memory')
        .insert({
          org_id: orgId,
          category: args.category,
          subject: args.subject,
          content: args.content,
          source: args.source,
          confidence: 0.85,
          related_entities: args.related_entities,
        })
        .select('id')
        .single()

      if (error) return `Error storing memory: ${error.message}`
      const memId = (data as { id: string }).id

      // Background: generate embedding
      if (isOpenAIConfigured()) {
        generateEmbedding(`${args.subject}: ${args.content}`)
          .then(async (emb) => {
            if (emb) {
              await supabase.from('memory_embeddings').insert({ memory_id: memId, embedding: JSON.stringify(emb) })
            }
          })
          .catch(() => {})
      }

      return `Memory stored: ${args.subject} (${memId})`
    },
  })

  // ── WRITE: Create Commitment (DB) ────────────────────────────────────────

  const createCommitment = tool({
    name: 'create_commitment',
    description:
      'Create a new commitment discovered from email/Slack/calendar. Always recall_memory and query_commitments first to avoid duplicates.',
    parameters: z.object({
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      due_date: z.string().optional().describe('ISO date string (YYYY-MM-DD)'),
      source: z.string().optional().describe('Where discovered (e.g., "email from CEO", "Slack #product")'),
      tags: z.array(z.string()).optional(),
    }),
    execute: async (args) => {
      const { data, error } = await supabase
        .from('commitments')
        .insert({
          org_id: orgId,
          title: args.title,
          description: args.description,
          priority: args.priority,
          due_date: args.due_date,
          source: args.source ?? 'agentic-patrol',
          tags: args.tags,
        })
        .select('id, title')
        .single()

      if (error) return `Error creating commitment: ${error.message}`
      const row = data as { id: string; title: string }
      return `Commitment created: ${row.title} (${row.id})`
    },
  })

  // ── WRITE: Update Commitment (DB) ────────────────────────────────────────

  const updateCommitment = tool({
    name: 'update_commitment',
    description:
      'Update an existing commitment when external signals affect its status (e.g., email confirms completion, Slack indicates blocker).',
    parameters: z.object({
      id: z.string(),
      status: z.enum(['active', 'at_risk', 'overdue', 'completed', 'cancelled']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      description: z.string().optional(),
    }),
    execute: async (args) => {
      const { id, ...updates } = args
      const updateData: Record<string, unknown> = {}
      if (updates.status) updateData.status = updates.status
      if (updates.priority) updateData.priority = updates.priority
      if (updates.description) updateData.description = updates.description
      if (updates.status === 'completed') updateData.completed_at = new Date().toISOString()

      const { error } = await supabase.from('commitments').update(updateData).eq('id', id).eq('org_id', orgId)

      if (error) return `Error updating commitment: ${error.message}`
      return `Commitment ${id} updated.`
    },
  })

  return [
    readRecentEmails,
    searchEmails,
    getSlackMentions,
    readSlackChannel,
    listSlackChannels,
    getTodayEvents,
    getComplianceOverview,
    queryCommitments,
    recallMemory,
    storeMemory,
    createCommitment,
    updateCommitment,
  ]
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPatrolAnalystPrompt(
  dbContext: WorkerViews,
  connectedIntegrations: string[]
): string {
  const sections: string[] = []

  sections.push(`You are the Patrol Analyst — a background intelligence agent that scans connected integrations, correlates signals with tracked organizational state, and discovers new commitments, risks, and insights.

## Your Mission
1. **Scan** each connected integration for recent activity (last 24h)
2. **Cross-reference** findings with existing commitments, memory, and patrol data
3. **Discover** new commitments, risks, and patterns
4. **Store** important context in memory for future use
5. **Output** structured findings

## Connected Integrations
${connectedIntegrations.length > 0 ? connectedIntegrations.map((i) => `- ${i}`).join('\n') : '- None (only DB tools available)'}

## Current Organizational State (from DB — zero cost to you)

### Program Status
- Active commitments: ${dbContext.cole.activeCount}
- At risk: ${dbContext.cole.atRiskCount}
- Overdue: ${dbContext.cole.overdueCount}
- Pending actions: ${dbContext.cole.pendingActionsCount}${dbContext.cole.oldestActionDays ? ` (oldest: ${dbContext.cole.oldestActionDays}d)` : ''}
`)

  if (dbContext.cole.topDeadlines.length > 0) {
    sections.push('### Upcoming Deadlines (by risk)')
    for (const d of dbContext.cole.topDeadlines) {
      sections.push(`- "${d.title}" — due ${d.due_date}, ${d.priority}, risk ${d.risk_score}/100, ${d.status}`)
    }
  }

  sections.push(`
### Compliance
- Vanta connected: ${dbContext.rhea.hasVantaConnection ? 'yes' : 'no'}
- Failing controls: ${dbContext.rhea.failingControlsCount}
- Compliance findings: ${dbContext.rhea.complianceFindings}

### Patrol Findings (existing)
- Open: ${dbContext.patrol.openFindingsCount}
- Critical: ${dbContext.patrol.criticalFindings}
- New since yesterday: ${dbContext.patrol.newSinceYesterday}
`)

  if (dbContext.eve.keyStakeholders.length > 0) {
    sections.push(
      `### Key Stakeholders\n${dbContext.eve.keyStakeholders.map((s) => `- ${s.name} (${s.mention_count} mentions)`).join('\n')}`
    )
  }

  sections.push(`
## Scanning Instructions

### Priority Order
1. If email is connected: scan recent emails for commitments, deadlines, action items, follow-ups
2. If Slack is connected: check @mentions, then scan key channels for blockers, decisions, updates
3. If calendar is connected: check today+tomorrow for deadline conflicts with commitments
4. If Vanta is connected: cross-reference failing controls with tracked commitments

### Cross-Referencing Rules
- ALWAYS query_commitments before creating a new one — avoid duplicates
- ALWAYS recall_memory before store_memory — check if knowledge exists
- When you find something related to an at-risk commitment, update it with new context
- When you find deadline mentions in email/Slack, check for existing commitments with similar titles
- Look for commitment-calendar conflicts (meeting during deadline, etc.)

### Cost Discipline
- Focus on summaries and metadata first, don't read full email bodies unless the subject indicates a commitment
- Scan mentions + 2-3 key channels max, not all channels
- Limit to 15 emails, 20 messages per channel
- Stop early if no integrations have meaningful findings

### Output
You MUST produce structured output matching the PatrolFindings schema.
- Only include genuine findings — not noise
- Severity guide: critical = needs immediate attention, high = needs action today, medium = should be addressed, low = FYI
- Include source_integrations for each finding (which integrations contributed)
- Summary should be 1-2 sentences capturing the scan result
`)

  return sections.join('\n')
}

// ─── OpenRouter Provider ─────────────────────────────────────────────────────
// Use the existing OPENROUTER_API_KEY to route to any model (Grok, GPT, etc.)
// Falls back to OPENAI_API_KEY + direct OpenAI if OpenRouter isn't configured.

function getPatrolProvider(): OpenAIProvider {
  const openRouterKey = process.env.OPENROUTER_API_KEY
  if (openRouterKey) {
    return new OpenAIProvider({
      apiKey: openRouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      useResponses: false, // OpenRouter only supports chat completions
    })
  }

  // Fallback to direct OpenAI
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    return new OpenAIProvider({
      apiKey: openaiKey,
      useResponses: false,
    })
  }

  throw new Error('Neither OPENROUTER_API_KEY nor OPENAI_API_KEY is configured')
}

// Default model: Grok 4.1 fast via OpenRouter (matches existing extractor model)
const DEFAULT_PATROL_MODEL = 'x-ai/grok-4.1-fast'

// ─── Agent Factory + Runner ──────────────────────────────────────────────────

export function createPatrolAgent(orgId: string, prompt: string) {
  const tools = createPatrolTools(orgId)
  const model = process.env.PATROL_MODEL || DEFAULT_PATROL_MODEL

  // Force chat completions API (OpenRouter doesn't support responses API)
  setOpenAIAPI('chat_completions')

  return new Agent({
    name: 'Patrol Analyst',
    instructions: prompt,
    model,
    tools,
    outputType: PatrolFindingsSchema,
  })
}

export async function runPatrolAgent(
  orgId: string,
  userId: string,
  connectedIntegrations: string[],
  dbContext: WorkerViews
): Promise<{ output: PatrolFindings; usage: { input: number; output: number } }> {
  const prompt = buildPatrolAnalystPrompt(dbContext, connectedIntegrations)
  const agent = createPatrolAgent(orgId, prompt)

  // Use Runner class to pass modelProvider (OpenRouter) at config level
  const runner = new Runner({
    modelProvider: getPatrolProvider(),
  })

  const result = await runner.run(agent, prompt, {
    maxTurns: 15,
  })

  // Extract usage — RunResult may or may not expose usage, cast via unknown
  const resultAny = result as unknown as { finalOutput: unknown; usage?: { inputTokens?: number; outputTokens?: number } }

  return {
    output: result.finalOutput as PatrolFindings,
    usage: {
      input: resultAny.usage?.inputTokens ?? 0,
      output: resultAny.usage?.outputTokens ?? 0,
    },
  }
}
