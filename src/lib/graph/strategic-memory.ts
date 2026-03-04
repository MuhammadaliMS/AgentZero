/**
 * Strategic Memory Layer — Phase D of Chief-of-Staff Agent V1.
 *
 * Adds strategic narrative memory alongside the entity graph:
 * - Ongoing initiatives with political context
 * - Connected decision threads with lessons learned
 * - Risk threads tracking evolving threats
 * - Relationship dynamics between key people/teams
 *
 * Memory Curator decides: promote / merge / archive / reactivate.
 * All operations are fire-and-forget safe.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

// ─── Types ────────────────────────────────────────────────────────────────

export type NarrativeType =
  | 'initiative'
  | 'political_context'
  | 'decision_thread'
  | 'risk_thread'
  | 'relationship_dynamic'

export type NarrativeStatus = 'active' | 'dormant' | 'archived' | 'pinned'

export type CurationAction =
  | 'promote'
  | 'decay'
  | 'reactivate'
  | 'merge'
  | 'archive'
  | 'pin'
  | 'unpin'
  | 'update_narrative'

export type CurationTrigger =
  | 'ghost_agent'
  | 'chat'
  | 'manual'
  | 'decay_cycle'
  | 'extraction'

export interface KeyFact {
  fact: string
  source?: string
  confidence?: number
  timestamp?: string
}

export interface DecisionRecord {
  decision: string
  date?: string
  outcome?: string
  lesson?: string
}

export interface PriorOutcome {
  outcome: string
  impact?: string
  date?: string
}

export interface OpenQuestion {
  question: string
  context?: string
  priority?: 'high' | 'medium' | 'low'
}

export interface NarrativeParams {
  orgId: string
  title: string
  narrativeType: NarrativeType
  summary: string
  keyFacts?: KeyFact[]
  decisionHistory?: DecisionRecord[]
  priorOutcomes?: PriorOutcome[]
  openQuestions?: OpenQuestion[]
  relatedEntityIds?: string[]
  relatedOutcomeIds?: string[]
  lastUpdatedBy?: string
}

export interface StrategicNarrative {
  id: string
  orgId: string
  title: string
  narrativeType: NarrativeType
  summary: string
  keyFacts: KeyFact[]
  decisionHistory: DecisionRecord[]
  priorOutcomes: PriorOutcome[]
  openQuestions: OpenQuestion[]
  relatedEntityIds: string[]
  relatedOutcomeIds: string[]
  status: NarrativeStatus
  promotionScore: number
  lastUpdatedBy: string | null
  createdAt: string
  updatedAt: string
}

// ─── Narrative CRUD ───────────────────────────────────────────────────────

/**
 * Create or update a strategic narrative. Fire-and-forget safe.
 */
export async function upsertNarrative(
  params: NarrativeParams
): Promise<string | null> {
  try {
    const supabase = createAdminClient()

    // Check for existing narrative with same title + type
    const { data: existing } = await supabase
      .from('strategic_narratives')
      .select('id')
      .eq('org_id', params.orgId)
      .eq('title', params.title)
      .eq('narrative_type', params.narrativeType)
      .limit(1)

    if (existing && existing.length > 0) {
      // Update existing
      const { error } = await supabase
        .from('strategic_narratives')
        .update({
          summary: params.summary,
          key_facts: (params.keyFacts ?? []) as unknown as Json,
          decision_history: (params.decisionHistory ?? []) as unknown as Json,
          prior_outcomes: (params.priorOutcomes ?? []) as unknown as Json,
          open_questions: (params.openQuestions ?? []) as unknown as Json,
          related_entity_ids: params.relatedEntityIds ?? [],
          related_outcome_ids: params.relatedOutcomeIds ?? [],
          last_updated_by: params.lastUpdatedBy ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id)

      if (error) {
        console.error('[StrategicMemory] Failed to update narrative:', error.message)
        return null
      }
      return existing[0].id
    }

    // Create new
    const { data, error } = await supabase
      .from('strategic_narratives')
      .insert({
        org_id: params.orgId,
        title: params.title,
        narrative_type: params.narrativeType,
        summary: params.summary,
        key_facts: (params.keyFacts ?? []) as unknown as Json,
        decision_history: (params.decisionHistory ?? []) as unknown as Json,
        prior_outcomes: (params.priorOutcomes ?? []) as unknown as Json,
        open_questions: (params.openQuestions ?? []) as unknown as Json,
        related_entity_ids: params.relatedEntityIds ?? [],
        related_outcome_ids: params.relatedOutcomeIds ?? [],
        last_updated_by: params.lastUpdatedBy ?? null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[StrategicMemory] Failed to create narrative:', error.message)
      return null
    }

    console.log(`[StrategicMemory] Created narrative ${data.id}: "${params.title.slice(0, 60)}"`)
    return data.id
  } catch (error) {
    console.error('[StrategicMemory] Exception in upsertNarrative:', error)
    return null
  }
}

/**
 * Get active narratives for an org.
 */
export async function getActiveNarratives(
  orgId: string,
  opts?: { narrativeType?: NarrativeType; limit?: number }
): Promise<StrategicNarrative[]> {
  try {
    const supabase = createAdminClient()

    let q = supabase
      .from('strategic_narratives')
      .select('*')
      .eq('org_id', orgId)
      .in('status', ['active', 'pinned'])
      .order('promotion_score', { ascending: false })
      .limit(opts?.limit ?? 20)

    if (opts?.narrativeType) {
      q = q.eq('narrative_type', opts.narrativeType)
    }

    const { data, error } = await q
    if (error || !data) return []

    return data.map(mapRowToNarrative)
  } catch {
    return []
  }
}

/**
 * Get narratives related to specific entities.
 */
export async function getNarrativesForEntities(
  orgId: string,
  entityIds: string[],
  limit = 5
): Promise<StrategicNarrative[]> {
  try {
    if (entityIds.length === 0) return []
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('strategic_narratives')
      .select('*')
      .eq('org_id', orgId)
      .in('status', ['active', 'pinned'])
      .overlaps('related_entity_ids', entityIds)
      .order('promotion_score', { ascending: false })
      .limit(limit)

    if (error || !data) return []
    return data.map(mapRowToNarrative)
  } catch {
    return []
  }
}

// ─── Memory Curator ───────────────────────────────────────────────────────

/**
 * Log a curation action for audit trail.
 */
export async function logCurationAction(
  orgId: string,
  targetType: 'entity' | 'memory' | 'narrative' | 'insight' | 'relationship',
  targetId: string,
  action: CurationAction,
  triggeredBy: CurationTrigger,
  opts?: { scoreBefore?: number; scoreAfter?: number; rationale?: string }
): Promise<void> {
  try {
    const supabase = createAdminClient()

    await supabase.from('memory_curation_log').insert({
      org_id: orgId,
      target_type: targetType,
      target_id: targetId,
      action,
      score_before: opts?.scoreBefore ?? null,
      score_after: opts?.scoreAfter ?? null,
      rationale: opts?.rationale ?? null,
      triggered_by: triggeredBy,
    })
  } catch (error) {
    console.error('[StrategicMemory] Failed to log curation:', error)
  }
}

/**
 * Run the memory curator cycle for an org.
 * Evaluates narratives for promotion, decay, or archival.
 */
export async function runMemoryCurator(orgId: string): Promise<{
  promoted: number
  decayed: number
  archived: number
}> {
  const result = { promoted: 0, decayed: 0, archived: 0 }

  try {
    const supabase = createAdminClient()

    // Get all active narratives
    const { data: narratives } = await supabase
      .from('strategic_narratives')
      .select('*')
      .eq('org_id', orgId)
      .in('status', ['active', 'dormant'])

    if (!narratives || narratives.length === 0) return result

    for (const narrative of narratives) {
      const daysSinceUpdate = (Date.now() - new Date(narrative.updated_at).getTime()) / (1000 * 60 * 60 * 24)
      const entityCount = (narrative.related_entity_ids as string[]).length
      const factCount = Array.isArray(narrative.key_facts) ? narrative.key_facts.length : 0
      const currentScore = narrative.promotion_score as number

      // Compute new promotion score
      let newScore = currentScore

      // Recency boost: narratives updated recently get a boost
      if (daysSinceUpdate < 7) newScore = Math.min(1.0, newScore + 0.1)
      else if (daysSinceUpdate < 30) newScore = Math.max(0, newScore - 0.05)
      else newScore = Math.max(0, newScore - 0.15)

      // Density boost: more connected narratives are more valuable
      if (entityCount >= 3) newScore = Math.min(1.0, newScore + 0.05)
      if (factCount >= 5) newScore = Math.min(1.0, newScore + 0.05)

      // Determine action
      if (narrative.status === 'active' && newScore < 0.2 && daysSinceUpdate > 30) {
        // Decay to dormant
        await supabase
          .from('strategic_narratives')
          .update({
            status: 'dormant' as const,
            promotion_score: newScore,
            updated_at: new Date().toISOString(),
          })
          .eq('id', narrative.id)

        await logCurationAction(orgId, 'narrative', narrative.id, 'decay', 'ghost_agent', {
          scoreBefore: currentScore,
          scoreAfter: newScore,
          rationale: `Inactive for ${daysSinceUpdate.toFixed(0)} days, score dropped to ${newScore.toFixed(2)}`,
        })
        result.decayed++
      } else if (narrative.status === 'dormant' && daysSinceUpdate > 60 && newScore < 0.1) {
        // Archive
        await supabase
          .from('strategic_narratives')
          .update({
            status: 'archived' as const,
            promotion_score: newScore,
            updated_at: new Date().toISOString(),
          })
          .eq('id', narrative.id)

        await logCurationAction(orgId, 'narrative', narrative.id, 'archive', 'ghost_agent', {
          scoreBefore: currentScore,
          scoreAfter: newScore,
          rationale: `Dormant for ${daysSinceUpdate.toFixed(0)} days, score ${newScore.toFixed(2)}`,
        })
        result.archived++
      } else if (newScore > currentScore) {
        // Promote (just bump score)
        await supabase
          .from('strategic_narratives')
          .update({ promotion_score: newScore })
          .eq('id', narrative.id)

        if (newScore - currentScore > 0.1) {
          await logCurationAction(orgId, 'narrative', narrative.id, 'promote', 'ghost_agent', {
            scoreBefore: currentScore,
            scoreAfter: newScore,
          })
          result.promoted++
        }
      } else if (newScore !== currentScore) {
        // Score changed but no state transition
        await supabase
          .from('strategic_narratives')
          .update({ promotion_score: newScore })
          .eq('id', narrative.id)
      }
    }

    console.log(`[StrategicMemory] Curator: promoted=${result.promoted}, decayed=${result.decayed}, archived=${result.archived}`)
    return result
  } catch (error) {
    console.error('[StrategicMemory] Curator cycle failed:', error)
    return result
  }
}

/**
 * Reactivate a dormant/archived narrative (e.g., when mentioned in conversation).
 */
export async function reactivateNarrative(
  narrativeId: string,
  trigger: CurationTrigger
): Promise<boolean> {
  try {
    const supabase = createAdminClient()

    const { data: narrative } = await supabase
      .from('strategic_narratives')
      .select('id, org_id, status, promotion_score')
      .eq('id', narrativeId)
      .single()

    if (!narrative || narrative.status === 'active' || narrative.status === 'pinned') return false

    const oldScore = narrative.promotion_score as number
    const newScore = Math.min(1.0, oldScore + 0.3)

    await supabase
      .from('strategic_narratives')
      .update({
        status: 'active' as const,
        promotion_score: newScore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', narrativeId)

    await logCurationAction(narrative.org_id, 'narrative', narrativeId, 'reactivate', trigger, {
      scoreBefore: oldScore,
      scoreAfter: newScore,
      rationale: `Reactivated from ${narrative.status} by ${trigger}`,
    })

    return true
  } catch {
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapRowToNarrative(row: Record<string, unknown>): StrategicNarrative {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    title: row.title as string,
    narrativeType: row.narrative_type as NarrativeType,
    summary: row.summary as string,
    keyFacts: (row.key_facts ?? []) as KeyFact[],
    decisionHistory: (row.decision_history ?? []) as DecisionRecord[],
    priorOutcomes: (row.prior_outcomes ?? []) as PriorOutcome[],
    openQuestions: (row.open_questions ?? []) as OpenQuestion[],
    relatedEntityIds: (row.related_entity_ids ?? []) as string[],
    relatedOutcomeIds: (row.related_outcome_ids ?? []) as string[],
    status: row.status as NarrativeStatus,
    promotionScore: row.promotion_score as number,
    lastUpdatedBy: row.last_updated_by as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
