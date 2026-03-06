/**
 * @deprecated — ORPHANED MODULE as of Chief Loop v2 rewrite (March 2026).
 *
 * The patrol cron route that called runPatrolScan() has been deleted.
 * The chief loop's LLM agent now handles all proactive scanning directly.
 * No active callers remain for this module.
 *
 * Safe to delete entirely.
 *
 * --- Original description ---
 * Patrol Scanner — Background scan logic for proactive intelligence.
 *
 * All pure DB queries + risk engine scoring. Zero LLM calls.
 * Produces patrol_findings that feed into the nudge engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  computeCommitmentRisk,
  getStatusTransition,
  getBlockerCount,
  daysSinceUpdate,
  isActionExpired,
} from './risk-engine'
import { updateOutcomeStatus } from '@/lib/agent/runtime/outcome-runtime'

type PatrolFindingInsert = Database['public']['Tables']['patrol_findings']['Insert']
type PatrolFindingType = PatrolFindingInsert['type']
type Severity = 'critical' | 'high' | 'medium' | 'low'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PatrolResult {
  findingsCreated: number
  findingsUpdated: number
  riskScoresUpdated: number
  statusTransitions: number
  actionsExpired: number
  findingsExpired: number
}

// ─── Main Scanner ───────────────────────────────────────────────────────────

export async function runPatrolScan(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<PatrolResult> {
  const result: PatrolResult = {
    findingsCreated: 0,
    findingsUpdated: 0,
    riskScoresUpdated: 0,
    statusTransitions: 0,
    actionsExpired: 0,
    findingsExpired: 0,
  }

  // Run all scans
  await Promise.all([
    scanDeadlineCommitments(supabase, orgId, result),
    scanStaleEntities(supabase, orgId, result),
    scanUnresolvedBlockers(supabase, orgId, result),
    scanExpiringActions(supabase, orgId, result),
  ])

  // Cleanup: expire old findings
  await expireOldFindings(supabase, orgId, result)

  return result
}

// ─── Helpers: Outcome Linking ────────────────────────────────────────────────

/**
 * Check if a commitment has a linked active outcome (planning/executing/blocked).
 * Returns the outcome row if found, null otherwise.
 */
async function findLinkedOutcome(
  supabase: SupabaseClient<Database>,
  orgId: string,
  conversationId: string | null
): Promise<{ id: string; status: string; blocker_summary: string | null } | null> {
  if (!conversationId) return null

  const { data } = await supabase
    .from('outcomes')
    .select('id, status, blocker_summary')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .in('status', ['planning', 'executing', 'blocked'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data ?? null
}

/**
 * Update an outcome's blocker_summary with deadline info from a patrol finding.
 * If the outcome is not already blocked, transitions it to 'blocked'.
 */
async function syncFindingToOutcome(
  outcomeRow: { id: string; status: string; blocker_summary: string | null },
  orgId: string,
  findingTitle: string
): Promise<void> {
  const blockerLine = `[Patrol] ${findingTitle}`
  const existingSummary = outcomeRow.blocker_summary ?? ''
  // Avoid duplicate lines
  if (existingSummary.includes(blockerLine)) return

  const newSummary = existingSummary
    ? `${existingSummary}\n${blockerLine}`
    : blockerLine

  // Keep the outcome in its current status but update the blocker summary
  await updateOutcomeStatus(
    outcomeRow.id,
    outcomeRow.status as 'planning' | 'executing' | 'blocked',
    { blockerSummary: newSummary, orgId }
  )
}

// ─── Scan: Deadline Commitments + Risk Scoring ──────────────────────────────

async function scanDeadlineCommitments(
  supabase: SupabaseClient<Database>,
  orgId: string,
  result: PatrolResult
): Promise<void> {
  const { data: commitments } = await supabase
    .from('commitments')
    .select('*')
    .eq('org_id', orgId)
    .in('status', ['active', 'at_risk', 'overdue'])

  if (!commitments || commitments.length === 0) return

  for (const commitment of commitments) {
    // Get blocker count and compute risk
    const blockerCount = await getBlockerCount(
      supabase,
      orgId,
      commitment.title,
      commitment.tags
    )
    const staleness = daysSinceUpdate(commitment)
    const riskScore = computeCommitmentRisk({
      commitment,
      blockerCount,
      daysSinceLastActivity: staleness,
    })

    // Update risk_score on the commitment
    await supabase
      .from('commitments')
      .update({
        risk_score: riskScore,
        risk_computed_at: new Date().toISOString(),
      })
      .eq('id', commitment.id)
    result.riskScoresUpdated++

    // Check for linked active outcome (planning/executing/blocked)
    const linkedOutcome = await findLinkedOutcome(supabase, orgId, commitment.conversation_id)
    const outcomeMetadata = linkedOutcome ? { outcome_id: linkedOutcome.id } : {}

    // Check for auto-status transitions
    const transition = getStatusTransition(commitment, riskScore)
    if (transition) {
      await supabase
        .from('commitments')
        .update({ status: transition.newStatus })
        .eq('id', commitment.id)
      result.statusTransitions++

      // Create finding for the transition
      const transitionTitle = transition.newStatus === 'overdue'
        ? `Overdue: ${commitment.title}`
        : `At Risk (score ${riskScore}): ${commitment.title}`

      await upsertFinding(supabase, orgId, {
        type: transition.newStatus === 'overdue' ? 'deadline_overdue' : 'at_risk_commitment',
        severity: riskScore >= 80 ? 'critical' : riskScore >= 60 ? 'high' : 'medium',
        title: transitionTitle,
        description: `Commitment "${commitment.title}" auto-transitioned to ${transition.newStatus}. Risk score: ${riskScore}/100.`,
        commitment_id: commitment.id,
        metadata: outcomeMetadata,
      }, result)

      // Sync to linked outcome's blocker_summary
      if (linkedOutcome) {
        await syncFindingToOutcome(linkedOutcome, orgId, transitionTitle)
      }
    }

    // Deadline proximity findings (only for non-overdue)
    if (commitment.due_date && commitment.status !== 'overdue') {
      const dueDate = new Date(commitment.due_date)
      const daysRemaining = (dueDate.getTime() - Date.now()) / 86_400_000

      let deadlineTitle: string | null = null

      if (daysRemaining <= 0) {
        // Already handled by overdue transition above
      } else if (daysRemaining <= 1) {
        deadlineTitle = `Due today: ${commitment.title}`
        await upsertFinding(supabase, orgId, {
          type: 'deadline_approaching',
          severity: 'critical',
          title: deadlineTitle,
          description: `Commitment due within 24 hours. Priority: ${commitment.priority}. Risk score: ${riskScore}.`,
          commitment_id: commitment.id,
          metadata: outcomeMetadata,
        }, result)
      } else if (daysRemaining <= 3) {
        deadlineTitle = `Due in ${Math.ceil(daysRemaining)} days: ${commitment.title}`
        await upsertFinding(supabase, orgId, {
          type: 'deadline_approaching',
          severity: 'high',
          title: deadlineTitle,
          description: `Commitment due within 3 days. Priority: ${commitment.priority}. Risk score: ${riskScore}.`,
          commitment_id: commitment.id,
          metadata: outcomeMetadata,
        }, result)
      } else if (daysRemaining <= 7) {
        deadlineTitle = `Due in ${Math.ceil(daysRemaining)} days: ${commitment.title}`
        await upsertFinding(supabase, orgId, {
          type: 'deadline_approaching',
          severity: 'medium',
          title: deadlineTitle,
          description: `Commitment due within 7 days. Priority: ${commitment.priority}. Risk score: ${riskScore}.`,
          commitment_id: commitment.id,
          metadata: outcomeMetadata,
        }, result)
      }

      // Sync deadline finding to linked outcome's blocker_summary
      if (linkedOutcome && deadlineTitle) {
        await syncFindingToOutcome(linkedOutcome, orgId, deadlineTitle)
      }
    }
  }
}

// ─── Scan: Stale Entities ───────────────────────────────────────────────────

async function scanStaleEntities(
  supabase: SupabaseClient<Database>,
  orgId: string,
  result: PatrolResult
): Promise<void> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data: staleEntities } = await supabase
    .from('entities')
    .select('id, name, entity_type, last_seen_at')
    .eq('org_id', orgId)
    .in('entity_type', ['project', 'feature'])
    .lt('last_seen_at', fourteenDaysAgo)

  if (!staleEntities) return

  for (const entity of staleEntities) {
    const isVerySale = entity.last_seen_at < thirtyDaysAgo
    const severity: Severity = isVerySale ? 'high' : 'medium'
    const daysSince = Math.round(
      (Date.now() - new Date(entity.last_seen_at).getTime()) / 86_400_000
    )

    await upsertFinding(supabase, orgId, {
      type: 'stale_entity',
      severity,
      title: `Stale ${entity.entity_type}: ${entity.name}`,
      description: `No activity for ${daysSince} days. Last seen: ${entity.last_seen_at}.`,
      entity_id: entity.id,
    }, result)
  }
}

// ─── Scan: Unresolved Blockers ──────────────────────────────────────────────

async function scanUnresolvedBlockers(
  supabase: SupabaseClient<Database>,
  orgId: string,
  result: PatrolResult
): Promise<void> {
  const { data: blockers } = await supabase
    .from('memory')
    .select('id, subject, content, created_at')
    .eq('org_id', orgId)
    .eq('category', 'blocker')

  if (!blockers) return

  for (const blocker of blockers) {
    const daysSinceCreated =
      (Date.now() - new Date(blocker.created_at).getTime()) / 86_400_000
    const severity: Severity = daysSinceCreated > 7 ? 'high' : 'medium'

    await upsertFinding(supabase, orgId, {
      type: 'unresolved_blocker',
      severity,
      title: `Unresolved blocker: ${blocker.subject}`,
      description: `Blocker "${blocker.subject}" has been open for ${Math.round(daysSinceCreated)} days.`,
      memory_id: blocker.id,
    }, result)
  }
}

// ─── Scan: Expiring Actions ─────────────────────────────────────────────────

async function scanExpiringActions(
  supabase: SupabaseClient<Database>,
  orgId: string,
  result: PatrolResult
): Promise<void> {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString()

  const { data: pendingActions } = await supabase
    .from('actions')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .lt('created_at', fiveDaysAgo)

  if (!pendingActions) return

  for (const action of pendingActions) {
    if (isActionExpired(action)) {
      // Auto-expire
      await supabase
        .from('actions')
        .update({ status: 'expired', resolved_at: new Date().toISOString() })
        .eq('id', action.id)
      result.actionsExpired++
    }

    const daysPending = Math.round(
      (Date.now() - new Date(action.created_at).getTime()) / 86_400_000
    )

    await upsertFinding(supabase, orgId, {
      type: 'action_expiring',
      severity: daysPending > 7 ? 'high' : 'medium',
      title: `Pending ${daysPending}d: ${action.title}`,
      description: `Action "${action.title}" has been pending for ${daysPending} days. Priority: ${action.priority}.`,
      action_id: action.id,
    }, result)
  }
}

// ─── Dedup / Upsert Finding ─────────────────────────────────────────────────

interface FindingInput {
  type: PatrolFindingType
  severity: Severity
  title: string
  description: string
  commitment_id?: string
  entity_id?: string
  action_id?: string
  memory_id?: string
  metadata?: Record<string, unknown>
}

async function upsertFinding(
  supabase: SupabaseClient<Database>,
  orgId: string,
  input: FindingInput,
  result: PatrolResult
): Promise<void> {
  // Build the dedup query
  let query = supabase
    .from('patrol_findings')
    .select('id')
    .eq('org_id', orgId)
    .eq('type', input.type)
    .eq('status', 'open')

  if (input.commitment_id) query = query.eq('commitment_id', input.commitment_id)
  if (input.entity_id) query = query.eq('entity_id', input.entity_id)
  if (input.action_id) query = query.eq('action_id', input.action_id)
  if (input.memory_id) query = query.eq('memory_id', input.memory_id)

  const { data: existing } = await query.limit(1).maybeSingle()

  if (existing) {
    // Update existing
    await supabase
      .from('patrol_findings')
      .update({
        severity: input.severity,
        title: input.title,
        description: input.description,
        metadata: { last_refreshed: new Date().toISOString(), ...input.metadata },
      })
      .eq('id', existing.id)
    result.findingsUpdated++
  } else {
    // Insert new
    await supabase.from('patrol_findings').insert({
      org_id: orgId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      description: input.description,
      commitment_id: input.commitment_id ?? null,
      entity_id: input.entity_id ?? null,
      action_id: input.action_id ?? null,
      memory_id: input.memory_id ?? null,
      status: 'open',
      metadata: { created_by_patrol: true, ...input.metadata },
    })
    result.findingsCreated++
  }
}

// ─── Cleanup: Expire old findings ───────────────────────────────────────────

async function expireOldFindings(
  supabase: SupabaseClient<Database>,
  orgId: string,
  result: PatrolResult
): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

  const { data } = await supabase
    .from('patrol_findings')
    .update({ status: 'expired' as const })
    .eq('org_id', orgId)
    .eq('status', 'open')
    .lt('created_at', sevenDaysAgo)
    .select('id')

  result.findingsExpired += data?.length ?? 0
}
