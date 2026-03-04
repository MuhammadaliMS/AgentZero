/**
 * Contradiction Detector — Pre-Store Guard
 *
 * Five typed checkers detect conflicts between new extraction data and
 * existing knowledge graph state. The pre-store guard prevents silent
 * overwrites of high-confidence prior memory.
 *
 * Rule: Never silently overwrite high-confidence prior memory.
 *
 * Checkers:
 *   1. Ownership — Two sources for same exclusive relationship
 *   2. Date — Date properties changed on same entity
 *   3. Status — Entity status conflicts
 *   4. Quantity — Numeric properties changed >20%
 *   5. Commitment-state — Graph vs commitments table conflicts
 *
 * Never throws — catches errors and returns empty results.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ResolvedRelationship {
  sourceId: string
  targetId: string
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
  confidence?: number
}

export interface DetectedContradiction {
  checkerType: 'ownership' | 'date' | 'status' | 'quantity' | 'commitment_state'
  idempotencyKey: string
  summary: string
  confidence: number
  category: string
  entityIds: string[]
  evidence: Record<string, unknown>
  blocked: boolean // true if the overwrite was blocked
}

export interface PreStoreGuardResult {
  allowed: ResolvedRelationship[]
  blocked: ResolvedRelationship[]
  contradictions: DetectedContradiction[]
}

// ─── Constants ────────────────────────────────────────────────────────────

const EXCLUSIVE_RELATIONSHIP_TYPES = new Set([
  'manages', 'owns', 'leads', 'reports_to', 'primary_contact',
  'heads', 'directs', 'supervises',
])

const HIGH_CONFIDENCE_THRESHOLD = 0.7

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Run the pre-store guard on a batch of new relationships.
 * Returns which relationships are safe to upsert, which are blocked,
 * and any contradictions detected.
 */
export async function runPreStoreGuard(
  orgId: string,
  conversationId: string,
  newRelationships: ResolvedRelationship[]
): Promise<PreStoreGuardResult> {
  const result: PreStoreGuardResult = {
    allowed: [],
    blocked: [],
    contradictions: [],
  }

  if (newRelationships.length === 0) return result

  const supabase = createAdminClient()

  for (const rel of newRelationships) {
    try {
      const contradictions: DetectedContradiction[] = []

      // Run all 5 checkers
      const checks = await Promise.all([
        checkOwnershipConflict(supabase, orgId, rel),
        checkDateConflict(supabase, orgId, rel),
        checkQuantityConflict(supabase, orgId, rel),
        checkStatusConflict(supabase, orgId, rel),
        checkCommitmentStateConflict(supabase, orgId, rel),
      ])

      for (const check of checks) {
        if (check) contradictions.push(check)
      }

      if (contradictions.length > 0) {
        // Check if existing data has high confidence
        const hasHighConfidenceConflict = contradictions.some(c => c.blocked)

        if (hasHighConfidenceConflict) {
          result.blocked.push(rel)
        } else {
          result.allowed.push(rel)
        }

        result.contradictions.push(...contradictions)
      } else {
        result.allowed.push(rel)
      }
    } catch (error) {
      // On error, allow the relationship (fail-open)
      console.error('[ContradictionDetector] Checker error:', error)
      result.allowed.push(rel)
    }
  }

  return result
}

// ─── Checker 1: Ownership Conflict ───────────────────────────────────────

async function checkOwnershipConflict(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  rel: ResolvedRelationship
): Promise<DetectedContradiction | null> {
  if (!EXCLUSIVE_RELATIONSHIP_TYPES.has(rel.type)) return null

  // Check if someone else already has this exclusive relationship to the target
  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id, source_entity_id, confidence')
    .eq('org_id', orgId)
    .eq('target_entity_id', rel.targetId)
    .eq('relationship_type', rel.type)
    .is('valid_to', null) // Only active relationships
    .neq('source_entity_id', rel.sourceId) // Different source
    .limit(1)
    .maybeSingle()

  if (!existing) return null

  // Get entity names for the summary
  const { data: entities } = await supabase
    .from('entities')
    .select('id, name')
    .in('id', [rel.sourceId, rel.targetId, existing.source_entity_id])

  const nameMap = new Map((entities ?? []).map(e => [e.id, e.name]))
  const existingSourceName = nameMap.get(existing.source_entity_id) ?? 'Unknown'
  const newSourceName = nameMap.get(rel.sourceId) ?? rel.source
  const targetName = nameMap.get(rel.targetId) ?? rel.target

  const existingConfidence = existing.confidence ?? 0.5
  const blocked = existingConfidence >= HIGH_CONFIDENCE_THRESHOLD

  const entityIds = [rel.sourceId, rel.targetId, existing.source_entity_id]
    .filter((v, i, a) => a.indexOf(v) === i) // unique

  return {
    checkerType: 'ownership',
    idempotencyKey: makeIdempotencyKey('ownership', entityIds),
    summary: `${newSourceName} and ${existingSourceName} both shown as ${rel.type} ${targetName}`,
    confidence: Math.min(existingConfidence + 0.1, 1.0),
    category: 'ownership_conflict',
    entityIds,
    evidence: {
      existing_source: existingSourceName,
      existing_source_id: existing.source_entity_id,
      new_source: newSourceName,
      new_source_id: rel.sourceId,
      target: targetName,
      target_id: rel.targetId,
      rel_type: rel.type,
      existing_confidence: existingConfidence,
    },
    blocked,
  }
}

// ─── Checker 2: Date Conflict ────────────────────────────────────────────

async function checkDateConflict(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  rel: ResolvedRelationship
): Promise<DetectedContradiction | null> {
  if (!rel.properties) return null

  // Look for date-like properties
  const dateFields = Object.entries(rel.properties).filter(([key, value]) => {
    if (typeof value !== 'string') return false
    return key.includes('date') || key.includes('deadline') || key.includes('due') ||
           /^\d{4}-\d{2}-\d{2}/.test(value)
  })

  if (dateFields.length === 0) return null

  // Check existing relationship properties for date conflicts
  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id, properties, confidence')
    .eq('org_id', orgId)
    .eq('source_entity_id', rel.sourceId)
    .eq('target_entity_id', rel.targetId)
    .eq('relationship_type', rel.type)
    .is('valid_to', null)
    .limit(1)
    .maybeSingle()

  if (!existing?.properties) return null

  const existingProps = existing.properties as Record<string, unknown>
  const existingConfidence = existing.confidence ?? 0.5

  for (const [field, newValue] of dateFields) {
    const oldValue = existingProps[field]
    if (oldValue && typeof oldValue === 'string' && oldValue !== newValue) {
      const blocked = existingConfidence >= HIGH_CONFIDENCE_THRESHOLD

      return {
        checkerType: 'date',
        idempotencyKey: makeIdempotencyKey('date', [rel.sourceId, rel.targetId]),
        summary: `Date conflict on ${rel.source} → ${rel.target}: ${field} changed from ${oldValue} to ${newValue}`,
        confidence: Math.min(existingConfidence + 0.05, 1.0),
        category: 'date_conflict',
        entityIds: [rel.sourceId, rel.targetId],
        evidence: {
          entity: rel.target,
          field,
          old_date: oldValue,
          new_date: newValue,
          existing_confidence: existingConfidence,
        },
        blocked,
      }
    }
  }

  return null
}

// ─── Checker 3: Quantity Conflict ────────────────────────────────────────

async function checkQuantityConflict(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  rel: ResolvedRelationship
): Promise<DetectedContradiction | null> {
  if (!rel.properties) return null

  // Look for numeric properties
  const numericFields = Object.entries(rel.properties).filter(
    ([, value]) => typeof value === 'number'
  )

  if (numericFields.length === 0) return null

  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id, properties, confidence')
    .eq('org_id', orgId)
    .eq('source_entity_id', rel.sourceId)
    .eq('target_entity_id', rel.targetId)
    .eq('relationship_type', rel.type)
    .is('valid_to', null)
    .limit(1)
    .maybeSingle()

  if (!existing?.properties) return null

  const existingProps = existing.properties as Record<string, unknown>
  const existingConfidence = existing.confidence ?? 0.5

  for (const [field, newValue] of numericFields) {
    const oldValue = existingProps[field]
    if (typeof oldValue === 'number' && typeof newValue === 'number' && oldValue !== 0) {
      const pctChange = Math.abs((newValue - oldValue) / oldValue)
      if (pctChange > 0.2) {
        const blocked = existingConfidence >= HIGH_CONFIDENCE_THRESHOLD

        return {
          checkerType: 'quantity',
          idempotencyKey: makeIdempotencyKey('quantity', [rel.sourceId, rel.targetId]),
          summary: `Quantity conflict on ${rel.source} → ${rel.target}: ${field} changed from ${oldValue} to ${newValue} (${Math.round(pctChange * 100)}% change)`,
          confidence: Math.min(existingConfidence + 0.05, 1.0),
          category: 'quantity_conflict',
          entityIds: [rel.sourceId, rel.targetId],
          evidence: {
            entity: rel.target,
            field,
            old_value: oldValue,
            new_value: newValue,
            pct_change: Math.round(pctChange * 100),
            existing_confidence: existingConfidence,
          },
          blocked,
        }
      }
    }
  }

  return null
}

// ─── Checker 4: Status Conflict ──────────────────────────────────────────

async function checkStatusConflict(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  rel: ResolvedRelationship
): Promise<DetectedContradiction | null> {
  if (!rel.properties) return null

  // Look for status-like properties
  const statusFields = Object.entries(rel.properties).filter(([key]) =>
    key === 'status' || key.includes('status') || key === 'state' || key.includes('phase')
  )

  if (statusFields.length === 0) return null

  // Check existing entity properties for status conflicts
  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id, properties, confidence')
    .eq('org_id', orgId)
    .eq('source_entity_id', rel.sourceId)
    .eq('target_entity_id', rel.targetId)
    .eq('relationship_type', rel.type)
    .is('valid_to', null)
    .limit(1)
    .maybeSingle()

  if (!existing?.properties) return null

  const existingProps = existing.properties as Record<string, unknown>
  const existingConfidence = existing.confidence ?? 0.5

  for (const [field, newValue] of statusFields) {
    const oldValue = existingProps[field]
    if (oldValue && typeof oldValue === 'string' && typeof newValue === 'string' && oldValue !== newValue) {
      const blocked = existingConfidence >= HIGH_CONFIDENCE_THRESHOLD

      return {
        checkerType: 'status',
        idempotencyKey: makeIdempotencyKey('status', [rel.sourceId, rel.targetId]),
        summary: `Status conflict on ${rel.source} → ${rel.target}: ${field} changed from "${oldValue}" to "${newValue}"`,
        confidence: Math.min(existingConfidence + 0.05, 1.0),
        category: 'status_conflict',
        entityIds: [rel.sourceId, rel.targetId],
        evidence: {
          entity: rel.target,
          field,
          old_status: oldValue,
          new_status: newValue,
          existing_confidence: existingConfidence,
        },
        blocked,
      }
    }
  }

  return null
}

// ─── Checker 5: Commitment-State Conflict ────────────────────────────────

async function checkCommitmentStateConflict(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  rel: ResolvedRelationship
): Promise<DetectedContradiction | null> {
  // Only check relationships that describe commitment-like states
  const commitmentRelTypes = new Set([
    'has_commitment', 'committed_to', 'responsible_for', 'assigned_to',
    'owns_action', 'delivers', 'depends_on',
  ])

  if (!commitmentRelTypes.has(rel.type)) return null

  // Check if there's a corresponding commitment in the commitments table
  // that conflicts with what the graph relationship claims.
  // Match by owner_id (source/target may be profile-linked entities).
  // Also match by title similarity to entity names.
  const { data: commitments } = await supabase
    .from('commitments')
    .select('id, title, status, owner_id')
    .eq('org_id', orgId)
    .in('status', ['active', 'at_risk', 'overdue', 'completed', 'cancelled'] as const)
    .limit(20)

  if (!commitments || commitments.length === 0) return null

  // Try to find commitments that reference the source or target entity by name
  const sourceName = rel.source.toLowerCase()
  const targetName = rel.target.toLowerCase()
  const relevantCommitments = commitments.filter(c => {
    const title = c.title.toLowerCase()
    return title.includes(sourceName) || title.includes(targetName)
  })

  if (relevantCommitments.length === 0) return null

  // Check for status mismatches — e.g. graph says "in_progress" but commitment is "completed"
  for (const commitment of relevantCommitments) {
    const relProps = rel.properties as Record<string, unknown> | undefined
    const graphStatus = relProps?.status as string | undefined

    if (graphStatus && commitment.status) {
      // Detect conflicts: graph says active/in-progress but commitment table says completed, or vice-versa
      const conflicting =
        (graphStatus === 'in_progress' && commitment.status === 'completed') ||
        (graphStatus === 'active' && commitment.status === 'completed') ||
        (graphStatus === 'done' && commitment.status === 'active') ||
        (graphStatus === 'blocked' && commitment.status === 'completed') ||
        (graphStatus === 'completed' && commitment.status === 'active')

      if (conflicting) {
        return {
          checkerType: 'commitment_state',
          idempotencyKey: makeIdempotencyKey('commitment_state', [rel.sourceId, rel.targetId, commitment.id]),
          summary: `Commitment state conflict: graph says "${graphStatus}" but commitments table shows "${commitment.status}" for "${commitment.title}"`,
          confidence: 0.75,
          category: 'commitment_state_conflict',
          entityIds: [rel.sourceId, rel.targetId],
          evidence: {
            commitment_id: commitment.id,
            commitment_title: commitment.title,
            graph_claim: graphStatus,
            db_state: commitment.status,
            relationship_type: rel.type,
          },
          blocked: false, // Don't block — flag for investigation
        }
      }
    }
  }

  return null
}

// ─── Store Contradictions ────────────────────────────────────────────────

/**
 * Persist detected contradictions as graph_insights and mark entities as conflicted.
 */
export async function storeContradictions(
  orgId: string,
  conversationId: string,
  contradictions: DetectedContradiction[]
): Promise<void> {
  if (contradictions.length === 0) return

  const supabase = createAdminClient()

  for (const c of contradictions) {
    try {
      // Upsert insight with idempotency
      await supabase.rpc('upsert_insight_with_dedupe', {
        p_org_id: orgId,
        p_idempotency_key: c.idempotencyKey,
        p_insight_type: 'contradiction',
        p_category: c.category,
        p_summary: c.summary,
        p_confidence: c.confidence,
        p_entity_ids: c.entityIds,
        p_evidence: c.evidence as unknown as Record<string, Json>,
        p_action_template: {
          type: 'resolve_contradiction',
          priority: c.blocked ? 'high' : 'medium',
          suggested_action: `Clarify which is correct: ${c.summary}`,
        },
      })

      // Set involved entities to 'conflicted' state if blocked
      if (c.blocked) {
        await supabase
          .from('entities')
          .update({ state: 'conflicted', updated_at: new Date().toISOString() })
          .in('id', c.entityIds)
          .eq('org_id', orgId)
          .neq('state', 'pinned') // Don't override pinned state
      }
    } catch (error) {
      console.error('[ContradictionDetector] Store error:', error)
    }
  }
}

// ─── Contradiction Resolution ────────────────────────────────────────────

/**
 * Resolve a contradiction: apply the chosen truth, update states.
 */
export async function resolveContradiction(
  orgId: string,
  contradictionId: string,
  chosenTruth: Record<string, unknown>,
  resolverId: string | null,
  source: 'chat' | 'slack' | 'brief' | 'auto',
  rationale?: string
): Promise<void> {
  const supabase = createAdminClient()

  // 1. Insert resolution record
  await supabase.from('contradiction_resolutions').insert({
    org_id: orgId,
    contradiction_id: contradictionId,
    chosen_truth: chosenTruth as unknown as Json,
    resolver_id: resolverId,
    resolution_source: source,
    rationale: rationale ?? null,
  })

  // 2. Get the insight to find involved entities
  const { data: insight } = await supabase
    .from('graph_insights')
    .select('related_entity_ids, evidence')
    .eq('id', contradictionId)
    .single()

  // 3. Update insight status
  await supabase
    .from('graph_insights')
    .update({
      status: 'dismissed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', contradictionId)

  // 4. Clear conflicted state on involved entities
  if (insight?.related_entity_ids) {
    await supabase
      .from('entities')
      .update({ state: 'active', updated_at: new Date().toISOString() })
      .in('id', insight.related_entity_ids)
      .eq('org_id', orgId)
      .eq('state', 'conflicted')
  }

  // 5. Apply chosen truth based on the keep directive
  const evidence = insight?.evidence as Record<string, unknown> | null
  if (evidence && chosenTruth.keep === 'new') {
    // Close the old conflicting relationship
    if (evidence.existing_source_id && evidence.target_id && evidence.rel_type) {
      await supabase
        .from('entity_relationships')
        .update({ valid_to: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('source_entity_id', evidence.existing_source_id as string)
        .eq('target_entity_id', evidence.target_id as string)
        .eq('relationship_type', evidence.rel_type as string)
        .is('valid_to', null)
    }

    // Insert the new relationship (the one that was blocked during extraction)
    if (evidence.new_source_id && evidence.target_id && evidence.rel_type) {
      await supabase
        .from('entity_relationships')
        .insert({
          org_id: orgId,
          source_entity_id: evidence.new_source_id as string,
          target_entity_id: evidence.target_id as string,
          relationship_type: evidence.rel_type as string,
          properties: (chosenTruth.properties ?? {}) as unknown as Json,
          confidence: 0.9, // High confidence — user-confirmed
          source_conversation_id: null,
        })
    }
  } else if (evidence && chosenTruth.keep === 'existing') {
    // User confirmed the existing relationship is correct — no changes needed.
    // If there was a blocked new relationship, it stays blocked.
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeIdempotencyKey(checkerType: string, entityIds: string[]): string {
  const today = new Date().toISOString().slice(0, 10)
  const sorted = [...entityIds].sort().join(':')
  return crypto
    .createHash('sha256')
    .update(`${checkerType}:${sorted}:${today}`)
    .digest('hex')
    .slice(0, 32)
}
