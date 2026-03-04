/**
 * Feedback Tracker — Tracks user interactions and computes signal weights.
 *
 * Records how users respond to briefs and nudges, then adjusts
 * per-user preference weights that influence future nudge scoring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { trackUtilityEventBatch } from '@/lib/graph/utility-tracker'
import { handleFindingResolved } from '@/lib/graph/insight-action-router'

type FeedbackSignalInsert = Database['public']['Tables']['feedback_signals']['Insert']

// ─── Signal Recording ───────────────────────────────────────────────────────

/** Track when a user reads a brief. */
export async function trackBriefRead(
  supabase: SupabaseClient<Database>,
  orgId: string,
  userId: string,
  briefId: string
): Promise<void> {
  await supabase.from('feedback_signals').insert({
    org_id: orgId,
    user_id: userId,
    signal_type: 'brief_read',
    source_type: 'brief',
    source_id: briefId,
    category: 'brief',
  } satisfies FeedbackSignalInsert)

  // Also update brief status
  await supabase
    .from('briefs')
    .update({ status: 'read' as const })
    .eq('id', briefId)
    .eq('user_id', userId)
}

/** Track when a user acknowledges a nudge. */
export async function trackNudgeAcknowledged(
  supabase: SupabaseClient<Database>,
  orgId: string,
  userId: string,
  nudgeId: string,
  category?: string
): Promise<void> {
  await supabase.from('feedback_signals').insert({
    org_id: orgId,
    user_id: userId,
    signal_type: 'nudge_acknowledged',
    source_type: 'nudge',
    source_id: nudgeId,
    category: category ?? 'nudge',
  } satisfies FeedbackSignalInsert)

  await supabase
    .from('nudges')
    .update({ status: 'acknowledged' as const })
    .eq('id', nudgeId)

  // Close the insight feedback loop for graph-sourced nudges:
  // 1. Resolve the insight_action (marks outcome, updates insight lifecycle)
  // 2. Track 'accepted' utility for involved entities
  try {
    const { data: nudgeRow } = await supabase
      .from('nudges')
      .select('source_finding_id')
      .eq('id', nudgeId)
      .maybeSingle()

    if (nudgeRow?.source_finding_id) {
      // This is the correct place to call handleFindingResolved —
      // the user has now actually acknowledged the nudge.
      handleFindingResolved(orgId, nudgeRow.source_finding_id, 'approved').catch(() => {})

      // Also track 'accepted' utility for entities involved in this insight
      const { data: insightAction } = await supabase
        .from('insight_actions')
        .select('insight_id')
        .eq('finding_id', nudgeRow.source_finding_id)
        .maybeSingle()

      if (insightAction?.insight_id) {
        const { data: insight } = await supabase
          .from('graph_insights')
          .select('related_entity_ids')
          .eq('id', insightAction.insight_id)
          .maybeSingle()

        if (insight?.related_entity_ids && insight.related_entity_ids.length > 0) {
          trackUtilityEventBatch(orgId, insight.related_entity_ids, 'accepted').catch(() => {})
        }
      }
    }
  } catch {
    // Fire-and-forget — don't fail the acknowledgment
  }
}

/** Track when a user dismisses a nudge. */
export async function trackNudgeDismissed(
  supabase: SupabaseClient<Database>,
  orgId: string,
  userId: string,
  nudgeId: string,
  category?: string
): Promise<void> {
  await supabase.from('feedback_signals').insert({
    org_id: orgId,
    user_id: userId,
    signal_type: 'nudge_dismissed',
    source_type: 'nudge',
    source_id: nudgeId,
    category: category ?? 'nudge',
  } satisfies FeedbackSignalInsert)

  await supabase
    .from('nudges')
    .update({ status: 'dismissed' as const })
    .eq('id', nudgeId)
}

/** Track when an action is resolved after a nudge existed for it. */
export async function trackActionResolvedAfterNudge(
  supabase: SupabaseClient<Database>,
  orgId: string,
  userId: string,
  actionId: string
): Promise<void> {
  // Check if there was a nudge for this action
  const { data: nudge } = await supabase
    .from('nudges')
    .select('id, type')
    .eq('org_id', orgId)
    .eq('action_id', actionId)
    .eq('status', 'sent')
    .limit(1)
    .maybeSingle()

  if (!nudge) return

  await supabase.from('feedback_signals').insert({
    org_id: orgId,
    user_id: userId,
    signal_type: 'action_resolved_after_nudge',
    source_type: 'action',
    source_id: actionId,
    category: nudge.type,
    metadata: { nudge_id: nudge.id },
  } satisfies FeedbackSignalInsert)
}

// ─── Commitment Detection ───────────────────────────────────────────────────

/**
 * Detect commitments that were updated within 24h of a brief mention.
 * This signals the user acted on briefed items.
 */
export async function detectActedOnCommitments(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<number> {
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString()

  // Find commitments updated in the last 24h
  const { data: recentlyUpdated } = await supabase
    .from('commitments')
    .select('id, owner_id')
    .eq('org_id', orgId)
    .gte('updated_at', oneDayAgo)
    .in('status', ['completed', 'at_risk', 'active'])

  if (!recentlyUpdated || recentlyUpdated.length === 0) return 0

  let detected = 0
  for (const commitment of recentlyUpdated) {
    if (!commitment.owner_id) continue

    // Check if there's a recent nudge about this commitment
    const { data: recentNudge } = await supabase
      .from('nudges')
      .select('id')
      .eq('org_id', orgId)
      .eq('commitment_id', commitment.id)
      .gte('created_at', oneDayAgo)
      .limit(1)
      .maybeSingle()

    if (!recentNudge) continue

    // Check we haven't already recorded this signal
    const { data: existingSignal } = await supabase
      .from('feedback_signals')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', commitment.owner_id)
      .eq('signal_type', 'commitment_acted_on')
      .eq('source_id', commitment.id)
      .gte('created_at', oneDayAgo)
      .limit(1)
      .maybeSingle()

    if (existingSignal) continue

    await supabase.from('feedback_signals').insert({
      org_id: orgId,
      user_id: commitment.owner_id,
      signal_type: 'commitment_acted_on',
      source_type: 'commitment',
      source_id: commitment.id,
      category: 'commitment',
    })
    detected++
  }

  return detected
}

// ─── Weight Computation ─────────────────────────────────────────────────────

/**
 * Recompute signal weights for all users in an org.
 *
 * Weight formula:
 *   weight = 0.5 + (acted_count / total_count) * 1.0
 *   Range: 0.5 (always dismissed) → 1.5 (always acted on)
 *   Default 1.0 until ≥5 total signals
 */
export async function recomputeSignalWeights(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<number> {
  // Get all feedback signals grouped by user + category
  const { data: signals } = await supabase
    .from('feedback_signals')
    .select('user_id, signal_type, category')
    .eq('org_id', orgId)

  if (!signals || signals.length === 0) return 0

  // Group by user_id + category
  const grouped = new Map<string, { acted: number; dismissed: number; total: number }>()

  for (const signal of signals) {
    const category = signal.category ?? 'general'
    const key = `${signal.user_id}::${category}`

    if (!grouped.has(key)) {
      grouped.set(key, { acted: 0, dismissed: 0, total: 0 })
    }
    const bucket = grouped.get(key)!
    bucket.total++

    if (
      signal.signal_type === 'nudge_acknowledged' ||
      signal.signal_type === 'commitment_acted_on' ||
      signal.signal_type === 'action_resolved_after_nudge'
    ) {
      bucket.acted++
    } else if (signal.signal_type === 'nudge_dismissed') {
      bucket.dismissed++
    }
  }

  // Upsert weights
  let updated = 0
  for (const [key, bucket] of grouped) {
    const [userId, category] = key.split('::')
    const weight =
      bucket.total < 5 ? 1.0 : 0.5 + (bucket.acted / bucket.total) * 1.0

    await supabase.from('user_signal_weights').upsert(
      {
        org_id: orgId,
        user_id: userId,
        category,
        weight: Math.round(weight * 100) / 100,
        acted_count: bucket.acted,
        dismissed_count: bucket.dismissed,
        total_count: bucket.total,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,category' }
    )
    updated++
  }

  return updated
}

// ─── Weight Lookup ──────────────────────────────────────────────────────────

/**
 * Get the signal weight for a specific user + category.
 * Returns 1.0 as default if no weight exists.
 */
export async function getUserWeight(
  supabase: SupabaseClient<Database>,
  userId: string,
  category: string
): Promise<number> {
  const { data } = await supabase
    .from('user_signal_weights')
    .select('weight')
    .eq('user_id', userId)
    .eq('category', category)
    .maybeSingle()

  return data?.weight ?? 1.0
}
