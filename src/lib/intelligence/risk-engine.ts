/**
 * Risk Inference Engine — Pure scoring functions, zero LLM calls.
 *
 * Computes risk scores for commitments based on deadline proximity,
 * blocker count, staleness, current status, and priority multiplier.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

type Commitment = Database['public']['Tables']['commitments']['Row']

// ─── Constants ──────────────────────────────────────────────────────────────

const PRIORITY_MULTIPLIER: Record<string, number> = {
  critical: 1.5,
  high: 1.2,
  medium: 1.0,
  low: 0.7,
}

const ACTION_EXPIRY_DAYS = 7

// ─── Risk Scoring ───────────────────────────────────────────────────────────

export interface RiskInput {
  commitment: Commitment
  blockerCount: number
  daysSinceLastActivity: number
}

/**
 * Compute a risk score (0-100) for a single commitment.
 *
 * Formula:
 *   1. Deadline Factor (0-70 pts)
 *   2. Blocker Factor (0-20 pts)
 *   3. Staleness Factor (0-15 pts)
 *   4. Status Boost (0-15 pts)
 *   Final = min(100, round(raw * PRIORITY_MULTIPLIER[priority]))
 */
export function computeCommitmentRisk(input: RiskInput): number {
  const { commitment, blockerCount, daysSinceLastActivity } = input
  let raw = 0

  // ── 1. Deadline Factor (0-70 pts) ──────────────────────────────────────
  if (!commitment.due_date) {
    raw += 10 // Unknown deadline = mild concern
  } else {
    const dueDate = new Date(commitment.due_date)
    const now = new Date()
    const msPerDay = 86_400_000
    const daysRemaining = (dueDate.getTime() - now.getTime()) / msPerDay

    if (daysRemaining < 0) {
      // Overdue
      const daysOverdue = Math.abs(daysRemaining)
      raw += 50 + Math.min(daysOverdue * 2, 20) // 50-70
    } else {
      // Future — compute how far through the timeline we are
      const createdDate = new Date(commitment.created_at)
      const totalDays = Math.max(
        (dueDate.getTime() - createdDate.getTime()) / msPerDay,
        1
      )
      const elapsed = (now.getTime() - createdDate.getTime()) / msPerDay
      const progress = Math.min(elapsed / totalDays, 1)
      raw += Math.round(progress * 50) // 0-50
    }
  }

  // ── 2. Blocker Factor (0-20 pts) ───────────────────────────────────────
  raw += Math.min(blockerCount * 7, 20)

  // ── 3. Staleness Factor (0-15 pts) ─────────────────────────────────────
  if (daysSinceLastActivity < 3) {
    raw += 0
  } else if (daysSinceLastActivity < 7) {
    raw += 5
  } else if (daysSinceLastActivity < 14) {
    raw += 10
  } else {
    raw += 15
  }

  // ── 4. Status Boost (0-15 pts) ─────────────────────────────────────────
  if (commitment.status === 'overdue') {
    raw += 15
  } else if (commitment.status === 'at_risk') {
    raw += 10
  }

  // ── Apply priority multiplier ──────────────────────────────────────────
  const multiplier = PRIORITY_MULTIPLIER[commitment.priority] ?? 1.0
  return Math.min(100, Math.round(raw * multiplier))
}

// ─── Auto-status rules ──────────────────────────────────────────────────────

export interface StatusTransition {
  commitmentId: string
  newStatus: 'at_risk' | 'overdue'
  riskScore: number
}

/**
 * Determine if a commitment should automatically transition status.
 * Never auto-downgrades.
 */
export function getStatusTransition(
  commitment: Commitment,
  riskScore: number
): StatusTransition | null {
  // If already completed or cancelled, no transition
  if (commitment.status === 'completed' || commitment.status === 'cancelled') {
    return null
  }

  // Overdue check: due_date passed and status not completed/cancelled
  if (commitment.due_date) {
    const dueDate = new Date(commitment.due_date)
    if (
      dueDate.getTime() < Date.now() &&
      commitment.status !== 'overdue'
    ) {
      return {
        commitmentId: commitment.id,
        newStatus: 'overdue',
        riskScore,
      }
    }
  }

  // At-risk check: score ≥ 70 and currently active
  if (riskScore >= 70 && commitment.status === 'active') {
    return {
      commitmentId: commitment.id,
      newStatus: 'at_risk',
      riskScore,
    }
  }

  return null
}

// ─── Action Expiry ──────────────────────────────────────────────────────────

type Action = Database['public']['Tables']['actions']['Row']

/**
 * Returns true if an action has been pending for longer than the expiry threshold.
 */
export function isActionExpired(action: Action): boolean {
  if (action.status !== 'pending') return false
  const createdAt = new Date(action.created_at)
  const daysPending = (Date.now() - createdAt.getTime()) / 86_400_000
  return daysPending > ACTION_EXPIRY_DAYS
}

// ─── Blocker Count Helper ───────────────────────────────────────────────────

/**
 * Count blockers related to a commitment (pure DB queries, no LLM).
 * Checks memory items with category='blocker' that reference overlapping entities,
 * and entity_relationships with blocking relationship types.
 */
export async function getBlockerCount(
  supabase: SupabaseClient<Database>,
  orgId: string,
  commitmentTitle: string,
  tags: string[] | null
): Promise<number> {
  let count = 0

  // 1. Check memory blockers matching tags/entities
  if (tags && tags.length > 0) {
    const { data: blockerMemories } = await supabase
      .from('memory')
      .select('id')
      .eq('org_id', orgId)
      .eq('category', 'blocker')
      .overlaps('related_entities', tags)

    count += blockerMemories?.length ?? 0
  }

  // 2. Check entity_relationships with blocking types
  // First find entities matching the commitment title
  const searchTerm = commitmentTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '')
  const { data: matchingEntities } = await supabase
    .from('entities')
    .select('id')
    .eq('org_id', orgId)
    .ilike('canonical_name', `%${searchTerm.split(' ').slice(0, 3).join('%')}%`)
    .limit(5)

  if (matchingEntities && matchingEntities.length > 0) {
    const entityIds = matchingEntities.map((e) => e.id)
    const { data: blockingRels } = await supabase
      .from('entity_relationships')
      .select('id')
      .eq('org_id', orgId)
      .in('source_entity_id', entityIds)
      .ilike('relationship_type', '%block%')

    count += blockingRels?.length ?? 0
  }

  return count
}

// ─── Staleness Helper ───────────────────────────────────────────────────────

/**
 * Compute days since last relevant activity for a commitment.
 * Uses updated_at as proxy for activity.
 */
export function daysSinceUpdate(commitment: Commitment): number {
  const updatedAt = new Date(commitment.updated_at)
  return (Date.now() - updatedAt.getTime()) / 86_400_000
}
