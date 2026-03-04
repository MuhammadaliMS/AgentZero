/**
 * Associative Recall — Context Pack Service
 *
 * Builds a bounded, type-prioritized context block injected into the
 * system prompt before each agent turn.
 *
 * Hard constraints:
 *   - Max items: 8
 *   - Max token budget: ~1500 tokens
 *   - Latency budget: 800ms with per-step circuit breaker (300ms)
 *
 * Type-priority ordering:
 *   1. Active contradictions on mentioned entities   (weight 2.0)
 *   2. Active blockers/risks from patrol_findings    (weight 1.8)
 *   3. Direct entity context (connections + memories) (weight 1.0)
 *   4. Relevant pattern insights                      (weight 0.8)
 *   5. Stale warnings                                 (weight 0.6)
 *
 * Scoring:
 *   injection_score = relevance × freshness_gate × utility_boost × type_weight
 *
 * Never throws — catches errors and returns empty result.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, isOpenAIConfigured } from '@/lib/openai/client'

// ─── Types ────────────────────────────────────────────────────────────────

export interface AssociativeContext {
  contextBlock: string
  matchedEntityIds: string[]
  itemCount: number
  budgetUsed: number
  durationMs: number
}

interface ContextItem {
  type: 'contradiction' | 'blocker' | 'entity' | 'pattern' | 'stale'
  score: number
  tokens: number // estimated
  xml: string
  entityId?: string
}

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_ITEMS = 8
const MAX_TOKEN_BUDGET = 1500
const LATENCY_BUDGET_MS = 800
const STEP_TIMEOUT_MS = 300

const TYPE_WEIGHTS: Record<ContextItem['type'], number> = {
  contradiction: 2.0,
  blocker: 1.8,
  entity: 1.0,
  pattern: 0.8,
  stale: 0.6,
}

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Build the associative context pack for a user message.
 * Returns an XML block to append to the system prompt.
 * Never throws.
 */
export async function buildAssociativeContext(
  orgId: string,
  userMessage: string
): Promise<AssociativeContext | null> {
  const startTime = Date.now()

  try {
    const supabase = createAdminClient()

    // ── Step 1: Find matching entities ────────────────────────────────
    const matchedEntities = await findMatchingEntities(
      supabase, orgId, userMessage, startTime
    )

    if (matchedEntities.length === 0) {
      return null
    }

    // Limit to top 8 by similarity/relevance
    const topEntities = matchedEntities.slice(0, MAX_ITEMS)
    const entityIds = topEntities.map(e => e.id)

    // Reactivate dormant/archived entities that matched strongly
    const dormantMatches = topEntities.filter(
      e => (e.state === 'dormant' || e.state === 'archived') && e.similarity >= 0.7
    )
    if (dormantMatches.length > 0) {
      const dormantIds = dormantMatches.map(e => e.id)
      try {
        await supabase
          .from('entities')
          .update({ state: 'active' as const, last_decay_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .in('id', dormantIds)
          .eq('org_id', orgId)
      } catch {
        // fire-and-forget
      }

      console.log(`[AssociativeRecall] Reactivated ${dormantMatches.length} dormant entities: ${dormantMatches.map(e => e.name).join(', ')}`)
    }

    // ── Step 2: Gather context items (parallel, with timeout) ────────
    const items: ContextItem[] = []

    const elapsed = () => Date.now() - startTime

    // Parallel fetch with individual timeouts
    const [contradictions, blockers, entityContexts, patterns] = await Promise.all([
      // Contradictions on matched entities
      withTimeout(
        fetchContradictions(supabase, orgId, entityIds),
        STEP_TIMEOUT_MS,
        [] as ContextItem[]
      ),
      // Blockers/risks from patrol_findings
      withTimeout(
        fetchBlockers(supabase, orgId, entityIds),
        STEP_TIMEOUT_MS,
        [] as ContextItem[]
      ),
      // Entity context (1-hop + memories)
      elapsed() < LATENCY_BUDGET_MS - 200
        ? withTimeout(
            fetchEntityContexts(supabase, orgId, topEntities),
            STEP_TIMEOUT_MS,
            [] as ContextItem[]
          )
        : Promise.resolve([] as ContextItem[]),
      // Pattern insights
      elapsed() < LATENCY_BUDGET_MS - 100
        ? withTimeout(
            fetchPatternInsights(supabase, orgId, entityIds),
            STEP_TIMEOUT_MS,
            [] as ContextItem[]
          )
        : Promise.resolve([] as ContextItem[]),
    ])

    items.push(...contradictions, ...blockers, ...entityContexts, ...patterns)

    // ── Step 3: Score + rank + pack ──────────────────────────────────
    for (const item of items) {
      item.score *= TYPE_WEIGHTS[item.type]
    }

    // Sort by score descending
    items.sort((a, b) => b.score - a.score)

    // Greedy pack within budget
    const packed: ContextItem[] = []
    let budgetUsed = 0

    for (const item of items) {
      if (packed.length >= MAX_ITEMS) break
      if (budgetUsed + item.tokens > MAX_TOKEN_BUDGET) continue
      packed.push(item)
      budgetUsed += item.tokens
    }

    if (packed.length === 0) {
      return null
    }

    // ── Step 4: Assemble XML ─────────────────────────────────────────
    const durationMs = Date.now() - startTime
    const xmlLines = [
      `<associative_context entities="${entityIds.length}" items="${packed.length}" budget="${budgetUsed}/${MAX_TOKEN_BUDGET}" latency_ms="${durationMs}">`,
    ]

    for (const item of packed) {
      xmlLines.push(item.xml)
    }

    xmlLines.push('</associative_context>')

    const contextBlock = '\n\n' + xmlLines.join('\n')

    return {
      contextBlock,
      matchedEntityIds: entityIds,
      itemCount: packed.length,
      budgetUsed,
      durationMs,
    }
  } catch (error) {
    console.error('[AssociativeRecall] Error:', error)
    return null
  }
}

// ─── Entity Matching ──────────────────────────────────────────────────────

interface MatchedEntity {
  id: string
  name: string
  canonicalName: string
  entityType: string
  description: string | null
  mentionCount: number
  state: string
  utilityScore: number
  matchType: 'embedding' | 'exact'
  similarity: number
}

async function findMatchingEntities(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  userMessage: string,
  startTime: number
): Promise<MatchedEntity[]> {
  const entities = new Map<string, MatchedEntity>()

  // 1. Exact match — word-boundary regex on canonical names
  const exactPromise = withTimeout(
    (async () => {
      // Cap at 500 entities ordered by most recently accessed / highest utility
      // to stay within the 800ms budget as orgs grow.
      const { data: allEntities } = await supabase
        .from('entities')
        .select('id, name, canonical_name, entity_type, description, mention_count, state, utility_score')
        .eq('org_id', orgId)
        .in('state', ['active', 'pinned', 'dormant', 'conflicted', 'archived'])
        .order('last_accessed_at', { ascending: false, nullsFirst: false })
        .limit(500)

      if (!allEntities) return

      const lowerMessage = userMessage.toLowerCase()

      for (const e of allEntities) {
        // Check if entity name appears in message with word-boundary matching
        const canonical = e.canonical_name
        if (canonical.length >= 3) {
          // Use word boundary regex for short names to avoid false positives
          // (e.g. "api" matching "rapid"). For longer names (>=6), substring match is fine.
          const matched = canonical.length < 6
            ? new RegExp(`\\b${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(userMessage)
            : lowerMessage.includes(canonical)
          if (!matched) continue
          entities.set(e.id, {
            id: e.id,
            name: e.name,
            canonicalName: e.canonical_name,
            entityType: e.entity_type,
            description: e.description,
            mentionCount: e.mention_count,
            state: e.state ?? 'active',
            utilityScore: e.utility_score ?? 0,
            matchType: 'exact',
            similarity: 1.0,
          })
        }
      }
    })(),
    STEP_TIMEOUT_MS,
    undefined
  )

  // 2. Embedding match (if OpenAI configured)
  const embeddingPromise = isOpenAIConfigured()
    ? withTimeout(
        (async () => {
          const embedding = await generateEmbedding(userMessage)
          if (!embedding) return

          const { data: results } = await supabase.rpc('search_entities_by_embedding', {
            p_org_id: orgId,
            p_embedding: JSON.stringify(embedding),
            p_limit: 8,
            p_min_similarity: 0.65,
          })

          if (!results) return

          for (const r of results as Array<{
            entity_id: string
            entity_name: string
            entity_type: string
            entity_description: string | null
            canonical_name: string
            similarity: number
            mention_count: number
            entity_state: string
            utility: number
          }>) {
            if (!entities.has(r.entity_id)) {
              entities.set(r.entity_id, {
                id: r.entity_id,
                name: r.entity_name,
                canonicalName: r.canonical_name,
                entityType: r.entity_type,
                description: r.entity_description,
                mentionCount: r.mention_count,
                state: r.entity_state ?? 'active',
                utilityScore: r.utility ?? 0,
                matchType: 'embedding',
                similarity: r.similarity,
              })
            }
          }
        })(),
        STEP_TIMEOUT_MS * 2, // embedding gets more time
        undefined
      )
    : Promise.resolve()

  await Promise.all([exactPromise, embeddingPromise])

  // Sort: exact matches first, then by similarity
  return Array.from(entities.values()).sort((a, b) => {
    if (a.matchType === 'exact' && b.matchType !== 'exact') return -1
    if (b.matchType === 'exact' && a.matchType !== 'exact') return 1
    return b.similarity - a.similarity
  })
}

// ─── Context Item Fetchers ────────────────────────────────────────────────

function freshnessGate(createdAt: string): number {
  const daysOld = (Date.now() - new Date(createdAt).getTime()) / 86_400_000
  if (daysOld <= 7) return 1.0
  if (daysOld <= 14) return 0.7
  if (daysOld <= 30) return 0.4
  return 0.1
}

function utilityBoost(utilityScore: number): number {
  return 1.0 + Math.min(utilityScore, 1.0) * 0.5
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) // rough estimate: 4 chars per token
}

async function fetchContradictions(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entityIds: string[]
): Promise<ContextItem[]> {
  const { data: insights } = await supabase
    .from('graph_insights')
    .select('id, summary, confidence, category, created_at, related_entity_ids')
    .eq('org_id', orgId)
    .eq('insight_type', 'contradiction')
    .eq('status', 'active')
    .overlaps('related_entity_ids', entityIds)
    .limit(3)

  if (!insights) return []

  return insights.map(i => {
    const xml = `  <contradiction confidence="${i.confidence.toFixed(2)}" category="${i.category || 'unknown'}">\n    ${escapeXml(i.summary)}\n  </contradiction>`
    return {
      type: 'contradiction' as const,
      score: i.confidence * freshnessGate(i.created_at),
      tokens: estimateTokens(xml),
      xml,
      entityId: i.related_entity_ids?.[0],
    }
  })
}

async function fetchBlockers(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entityIds: string[]
): Promise<ContextItem[]> {
  const { data: findings } = await supabase
    .from('patrol_findings')
    .select('id, title, description, severity, type, created_at, entity_id')
    .eq('org_id', orgId)
    .eq('status', 'open')
    .in('entity_id', entityIds)
    .in('type', ['unresolved_blocker', 'at_risk_commitment', 'deadline_overdue', 'failing_control'])
    .limit(3)

  if (!findings) return []

  return findings.map(f => {
    const desc = f.description ? `: ${f.description.slice(0, 100)}` : ''
    const xml = `  <finding type="${f.type}" severity="${f.severity}">\n    ${escapeXml(f.title)}${escapeXml(desc)}\n  </finding>`
    const severityScore = f.severity === 'critical' ? 1.0 : f.severity === 'high' ? 0.8 : 0.6
    return {
      type: 'blocker' as const,
      score: severityScore * freshnessGate(f.created_at),
      tokens: estimateTokens(xml),
      xml,
      entityId: f.entity_id ?? undefined,
    }
  })
}

async function fetchEntityContexts(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entities: MatchedEntity[]
): Promise<ContextItem[]> {
  const items: ContextItem[] = []

  // Fetch in parallel for top entities (limit to 4 to stay in budget)
  const topEntities = entities.slice(0, 4)

  const results = await Promise.all(
    topEntities.map(async (entity) => {
      // 1-hop neighborhood
      const { data: neighbors } = await supabase.rpc('get_entity_neighborhood', {
        p_entity_id: entity.id,
        p_org_id: orgId,
        p_max_hops: 1,
        p_active_only: true,
      })

      // Top 2 linked memories
      const { data: links } = await supabase
        .from('memory_entity_links')
        .select('memory!inner(subject, content)')
        .eq('entity_id', entity.id)
        .limit(2)

      return { entity, neighbors, links }
    })
  )

  for (const { entity, neighbors, links } of results) {
    const connectionParts: string[] = []
    if (neighbors) {
      const edges = (neighbors as Array<{
        entity_name: string
        entity_type: string
        relationship_type: string | null
        relationship_direction: string | null
        hop_distance: number
      }>).filter(n => n.hop_distance === 1)
      for (const n of edges.slice(0, 5)) {
        const dir = n.relationship_direction === 'outgoing' ? '→' : '←'
        connectionParts.push(`${dir} ${n.relationship_type}: ${n.entity_name}`)
      }
    }

    const memoryParts: string[] = []
    if (links) {
      for (const link of links as Array<{ memory: { subject: string | null; content: string | null } }>) {
        if (link.memory?.subject) {
          const content = link.memory.content?.slice(0, 80) || ''
          memoryParts.push(`${link.memory.subject}: ${content}`)
        }
      }
    }

    const xmlParts = [`  <entity name="${escapeXml(entity.name)}" type="${entity.entityType}" relevance="${entity.similarity.toFixed(2)}" state="${entity.state}">`]
    if (connectionParts.length > 0) {
      xmlParts.push(`    <connections>${escapeXml(connectionParts.join(', '))}</connections>`)
    }
    for (const mem of memoryParts) {
      xmlParts.push(`    <memory>${escapeXml(mem)}</memory>`)
    }
    xmlParts.push('  </entity>')

    const xml = xmlParts.join('\n')

    items.push({
      type: 'entity',
      score: entity.similarity * utilityBoost(entity.utilityScore),
      tokens: estimateTokens(xml),
      xml,
      entityId: entity.id,
    })
  }

  return items
}

async function fetchPatternInsights(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  entityIds: string[]
): Promise<ContextItem[]> {
  const { data: insights } = await supabase
    .from('graph_insights')
    .select('id, summary, confidence, insight_type, created_at, related_entity_ids')
    .eq('org_id', orgId)
    .in('insight_type', ['pattern', 'anomaly', 'risk', 'opportunity', 'stale'])
    .eq('status', 'active')
    .overlaps('related_entity_ids', entityIds)
    .limit(4)

  if (!insights) return []

  return insights.map(i => {
    const itemType: ContextItem['type'] = i.insight_type === 'stale' ? 'stale' : 'pattern'
    const xml = `  <insight type="${i.insight_type}" confidence="${i.confidence.toFixed(2)}">\n    ${escapeXml(i.summary)}\n  </insight>`
    return {
      type: itemType,
      score: i.confidence * freshnessGate(i.created_at),
      tokens: estimateTokens(xml),
      xml,
      entityId: i.related_entity_ids?.[0],
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })

  try {
    const result = await Promise.race([promise, timeout])
    clearTimeout(timer!)
    return result
  } catch {
    clearTimeout(timer!)
    return fallback
  }
}
