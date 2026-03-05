/**
 * Smart Nudge Engine — Scoring, batching, and delivery of intelligent nudges.
 *
 * Pipeline:
 *   1. Gather candidates from patrol_findings + direct queries
 *   2. Score each with urgency formula
 *   3. Apply cooldown — skip if same item nudged within 8h
 *   4. Batch by user — one Slack DM per user
 *   5. Generate template-based message (no LLM)
 *   6. Assign priority tier
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getUserWeight } from './feedback-tracker'
// handleFindingResolved is called from feedback-tracker.ts when users acknowledge nudges,
// NOT at nudge generation time. See trackNudgeAcknowledged.

type PatrolFinding = Database['public']['Tables']['patrol_findings']['Row']

// ─── Constants ──────────────────────────────────────────────────────────────

const COOLDOWN_HOURS = 8
const SEVERITY_BASE: Record<string, number> = {
  critical: 80,
  high: 60,
  medium: 40,
  low: 20,
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NudgeCandidate {
  findingId: string | null
  userId: string
  orgId: string
  type: string
  title: string
  message: string
  urgencyScore: number
  priority: 'critical' | 'high' | 'medium' | 'low'
  commitmentId: string | null
  actionId: string | null
  entityId: string | null
  category: string
}

export interface NudgeBatch {
  userId: string
  orgId: string
  items: NudgeCandidate[]
  batchId: string
}

export interface NudgeRunResult {
  candidatesFound: number
  afterCooldown: number
  batchesSent: number
  nudgesRecorded: number
  batches: NudgeBatch[]
}

type NudgeRunMode = 'all' | 'noon' | 'monday_noon'

// ─── Main Entry ─────────────────────────────────────────────────────────────

/**
 * Run the smart nudge pipeline for an org.
 *
 * @param mode - Controls which priority tiers get sent:
 *   'all' — critical + high only (every run)
 *   'noon' — critical + high + medium (noon run)
 *   'monday_noon' — all tiers including low (Monday weekly digest)
 */
export async function runSmartNudge(
  supabase: SupabaseClient<Database>,
  orgId: string,
  mode: NudgeRunMode = 'all'
): Promise<NudgeRunResult> {
  const result: NudgeRunResult = {
    candidatesFound: 0,
    afterCooldown: 0,
    batchesSent: 0,
    nudgesRecorded: 0,
    batches: [],
  }

  // 1. Gather candidates
  const candidates = await gatherCandidates(supabase, orgId)
  result.candidatesFound = candidates.length

  // 2. Apply cooldown
  const cooled = await applyCooldown(supabase, orgId, candidates)
  result.afterCooldown = cooled.length

  // 3. Filter by mode (priority tier)
  const filtered = filterByMode(cooled, mode)

  // 4. Batch by user
  const batches = batchByUser(filtered)
  result.batchesSent = batches.length

  // 5. Record nudges in DB (Slack delivery happens in the cron route)
  for (const batch of batches) {
    for (const item of batch.items) {
      await supabase.from('nudges').insert({
        org_id: item.orgId,
        user_id: item.userId,
        type: item.type,
        title: item.title,
        content: item.message,
        priority: item.priority,
        status: 'pending',
        commitment_id: item.commitmentId,
        urgency_score: item.urgencyScore,
        source_finding_id: item.findingId,
        batch_id: batch.batchId,
      })
      result.nudgesRecorded++
    }

    // Mark findings as acknowledged (nudge created, not yet user-acted)
    const findingIds = batch.items
      .map((i) => i.findingId)
      .filter(Boolean) as string[]
    if (findingIds.length > 0) {
      await supabase
        .from('patrol_findings')
        .update({ status: 'acknowledged' as const })
        .in('id', findingIds)

      // NOTE: Do NOT call handleFindingResolved here — nudge was just *sent*.
      // The feedback loop fires when the user actually acknowledges the nudge,
      // via trackNudgeAcknowledged → handleFindingResolved in feedback-tracker.ts.
    }
  }

  result.batches = batches
  return result
}

// ─── Gather Candidates ──────────────────────────────────────────────────────

async function gatherCandidates(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<NudgeCandidate[]> {
  const candidates: NudgeCandidate[] = []

  // Get org members for assigning nudges
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .not('onboarded_at', 'is', null)

  if (!profiles || profiles.length === 0) return candidates
  // For now, nudge the first (primary) user. Multi-user assignment by owner_id.
  const defaultUserId = profiles[0].id

  // 1. From patrol findings
  const { data: findings } = await supabase
    .from('patrol_findings')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'open')

  if (findings) {
    for (const finding of findings) {
      // Determine target user (commitment owner or default)
      let targetUserId = defaultUserId
      if (finding.commitment_id) {
        const { data: commitment } = await supabase
          .from('commitments')
          .select('owner_id')
          .eq('id', finding.commitment_id)
          .maybeSingle()
        if (commitment?.owner_id) targetUserId = commitment.owner_id
      }

      const urgencyScore = await computeUrgencyScore(supabase, finding, targetUserId)
      const priority = urgencyToPriority(urgencyScore)

      candidates.push({
        findingId: finding.id,
        userId: targetUserId,
        orgId,
        type: finding.type,
        title: finding.title,
        message: buildFindingMessage(finding),
        urgencyScore,
        priority,
        commitmentId: finding.commitment_id,
        actionId: finding.action_id,
        entityId: finding.entity_id,
        category: finding.type,
      })
    }
  }

  // 2. Incomplete onboarding nudges
  const { data: incompleteOnboarding } = await supabase
    .from('onboarding_state')
    .select('user_id, steps')
    .eq('org_id', orgId)
    .eq('is_complete', false)

  if (incompleteOnboarding) {
    for (const onb of incompleteOnboarding) {
      const steps = (onb.steps as Array<{ name: string; status: string }>) || []
      const incomplete = steps.filter((s) => s.status !== 'completed')
      if (incomplete.length === 0) continue

      candidates.push({
        findingId: null,
        userId: onb.user_id,
        orgId,
        type: 'onboarding_incomplete',
        title: 'Complete your setup',
        message: `You have ${incomplete.length} integration${incomplete.length > 1 ? 's' : ''} left to connect. The more tools Captain can access, the more proactive it can be.`,
        urgencyScore: 35,
        priority: 'medium',
        commitmentId: null,
        actionId: null,
        entityId: null,
        category: 'onboarding',
      })
    }
  }

  return candidates
}

// ─── Urgency Scoring ────────────────────────────────────────────────────────

async function computeUrgencyScore(
  supabase: SupabaseClient<Database>,
  finding: PatrolFinding,
  userId: string
): Promise<number> {
  let raw = SEVERITY_BASE[finding.severity] ?? 40

  // Deadline proximity bonus (if commitment has a due date)
  if (finding.commitment_id) {
    const { data: commitment } = await supabase
      .from('commitments')
      .select('due_date, priority')
      .eq('id', finding.commitment_id)
      .maybeSingle()

    if (commitment?.due_date) {
      const daysRemaining =
        (new Date(commitment.due_date).getTime() - Date.now()) / 86_400_000

      if (daysRemaining < 0) raw += 25 // Overdue
      else if (daysRemaining <= 1) raw += 20
      else if (daysRemaining <= 3) raw += 10
    }

    // Priority boost
    if (commitment?.priority === 'critical') raw += 15
    else if (commitment?.priority === 'high') raw += 10
  }

  // Action age bonus
  if (finding.action_id) {
    const { data: action } = await supabase
      .from('actions')
      .select('created_at')
      .eq('id', finding.action_id)
      .maybeSingle()

    if (action) {
      const daysPending =
        (Date.now() - new Date(action.created_at).getTime()) / 86_400_000
      raw += Math.min(daysPending * 4, 20)
    }
  }

  // Apply user signal weight
  const category = finding.type
  const weight = await getUserWeight(supabase, userId, category)
  const final = Math.max(0, Math.min(100, Math.round(raw * weight)))

  return final
}

function urgencyToPriority(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 80) return 'critical'
  if (score >= 60) return 'high'
  if (score >= 30) return 'medium'
  return 'low'
}

// ─── Cooldown ───────────────────────────────────────────────────────────────

async function applyCooldown(
  supabase: SupabaseClient<Database>,
  orgId: string,
  candidates: NudgeCandidate[]
): Promise<NudgeCandidate[]> {
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3_600_000).toISOString()

  // Get recent nudges
  const { data: recentNudges } = await supabase
    .from('nudges')
    .select('commitment_id, action_id, type, user_id')
    .eq('org_id', orgId)
    .gte('created_at', cutoff)

  if (!recentNudges || recentNudges.length === 0) return candidates

  // Build a set of recently-nudged keys
  const recentKeys = new Set<string>()
  for (const nudge of recentNudges) {
    if (nudge.commitment_id) {
      recentKeys.add(`${nudge.user_id}::commitment::${nudge.commitment_id}`)
    }
    if (nudge.action_id) {
      recentKeys.add(`${nudge.user_id}::action::${nudge.action_id}`)
    }
    recentKeys.add(`${nudge.user_id}::type::${nudge.type}`)
  }

  return candidates.filter((c) => {
    if (c.commitmentId && recentKeys.has(`${c.userId}::commitment::${c.commitmentId}`)) {
      return false
    }
    if (c.actionId && recentKeys.has(`${c.userId}::action::${c.actionId}`)) {
      return false
    }
    // For non-commitment/action nudges, check by type
    if (!c.commitmentId && !c.actionId && recentKeys.has(`${c.userId}::type::${c.type}`)) {
      return false
    }
    return true
  })
}

// ─── Priority Filter ────────────────────────────────────────────────────────

function filterByMode(
  candidates: NudgeCandidate[],
  mode: NudgeRunMode
): NudgeCandidate[] {
  switch (mode) {
    case 'all':
      // Only critical + high
      return candidates.filter((c) => c.priority === 'critical' || c.priority === 'high')
    case 'noon':
      // critical + high + medium
      return candidates.filter((c) => c.priority !== 'low')
    case 'monday_noon':
      // Everything — weekly digest includes low
      return candidates
    default:
      return candidates
  }
}

// ─── Batching ───────────────────────────────────────────────────────────────

function batchByUser(candidates: NudgeCandidate[]): NudgeBatch[] {
  const byUser = new Map<string, NudgeCandidate[]>()

  for (const c of candidates) {
    const key = `${c.orgId}::${c.userId}`
    if (!byUser.has(key)) byUser.set(key, [])
    byUser.get(key)!.push(c)
  }

  const batchId = `batch_${Date.now()}`
  const batches: NudgeBatch[] = []

  for (const [, items] of byUser) {
    // Sort by urgency descending
    items.sort((a, b) => b.urgencyScore - a.urgencyScore)
    batches.push({
      userId: items[0].userId,
      orgId: items[0].orgId,
      items,
      batchId,
    })
  }

  return batches
}

// ─── Message Templates ──────────────────────────────────────────────────────

function buildFindingMessage(finding: PatrolFinding): string {
  const emoji = severityEmoji(finding.severity)
  const desc = finding.description ?? ''

  switch (finding.type) {
    case 'deadline_approaching':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'deadline_overdue':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'stale_entity':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'failing_control':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'unresolved_blocker':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'at_risk_commitment':
      return `${emoji} *${finding.title}*\n${desc}`
    case 'action_expiring':
      return `${emoji} *${finding.title}*\n${desc}`
    default:
      return `${emoji} *${finding.title}*\n${desc}`
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case 'critical':
      return '🚨'
    case 'high':
      return '⚠️'
    case 'medium':
      return '📋'
    case 'low':
      return '💡'
    default:
      return '📋'
  }
}

// ─── Direct Blocker DM (for chief-loop Phase F) ─────────────────────────────

/**
 * Send a blocker DM for a specific outcome step.
 * Creates a patrol_finding, posts to Slack, records nudge, and only marks
 * finding as acknowledged AFTER successful Slack delivery.
 *
 * If Slack delivery fails, finding stays 'open' so nudge cron can pick it up.
 *
 * Returns { sent: true } if DM was delivered, { sent: false, reason } if skipped.
 */
export async function sendBlockerDM(
  supabase: SupabaseClient<Database>,
  orgId: string,
  userId: string,
  opts: {
    findingId?: string
    outcomeId: string
    outcomeTitle: string
    stepId: string
    oneClearAsk: string
    severity?: 'critical' | 'high' | 'medium' | 'low'
    cooldownHours?: number
  }
): Promise<{ sent: boolean; findingId?: string; reason?: string }> {
  const cooldownHours = opts.cooldownHours ?? 4
  const severity = opts.severity ?? 'medium'

  // 1. Cooldown check — skip if we already nudged this outcome+step recently
  const cooldownCutoff = new Date(Date.now() - cooldownHours * 3_600_000).toISOString()

  const { data: recentFindings } = await supabase
    .from('patrol_findings')
    .select('id')
    .eq('org_id', orgId)
    .eq('type', 'unresolved_blocker')
    .gte('created_at', cooldownCutoff)
    .contains('metadata', { outcome_id: opts.outcomeId, step_id: opts.stepId })
    .limit(1)

  if (recentFindings && recentFindings.length > 0) {
    return { sent: false, reason: `Cooldown active (finding ${recentFindings[0].id})` }
  }

  // 2. Create patrol_finding (canonical blocker artifact) — stays 'open' until Slack delivers
  const slackMessage =
    `${severityEmoji(severity)} *Outcome blocked: ${opts.outcomeTitle}*\n` +
    `I need to know: ${opts.oneClearAsk}`

  const { data: finding, error: findingErr } = await supabase
    .from('patrol_findings')
    .insert({
      org_id: orgId,
      type: 'unresolved_blocker',
      severity,
      title: `Outcome blocked: ${opts.outcomeTitle}`,
      description: `📋 "${opts.outcomeTitle}" is blocked — I need to know: ${opts.oneClearAsk}`,
      metadata: {
        outcome_id: opts.outcomeId,
        step_id: opts.stepId,
        source: 'chief_loop',
      },
      status: 'open',
    })
    .select('id')
    .single()

  if (findingErr || !finding) {
    return { sent: false, reason: `Failed to create finding: ${findingErr?.message}` }
  }

  const findingId = (finding as { id: string }).id

  // 3. Actually deliver via Slack DM
  let slackDelivered = false
  try {
    const { getSlackClient } = await import('@/lib/slack/client')
    const slackClient = await getSlackClient(orgId)

    if (slackClient) {
      // Look up user email → Slack user → open DM
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', userId)
        .maybeSingle()

      if (profile?.email) {
        const userResult = await slackClient.users.lookupByEmail({ email: profile.email })
        if (userResult.user?.id) {
          const conversation = await slackClient.conversations.open({ users: userResult.user.id })
          if (conversation.channel?.id) {
            await slackClient.chat.postMessage({
              channel: conversation.channel.id,
              text: slackMessage,
            })
            slackDelivered = true
          }
        }
      }
    }
  } catch (err) {
    console.error(`[sendBlockerDM] Slack delivery failed for org=${orgId}:`, (err as Error).message)
    // Fall through — finding stays 'open' for nudge cron to pick up
  }

  // 4. Create nudge record
  const batchId = `chief_loop_${Date.now()}`
  await supabase.from('nudges').insert({
    org_id: orgId,
    user_id: userId,
    type: 'unresolved_blocker',
    title: `Outcome blocked: ${opts.outcomeTitle}`,
    content: `📋 "${opts.outcomeTitle}" is blocked — I need to know: ${opts.oneClearAsk}`,
    priority: severity,
    status: slackDelivered ? 'sent' : 'pending',
    sent_at: slackDelivered ? new Date().toISOString() : null,
    source_finding_id: findingId,
    urgency_score: severity === 'critical' ? 90 : severity === 'high' ? 70 : 50,
    batch_id: batchId,
  })

  // 5. Only mark finding as acknowledged AFTER successful Slack delivery.
  //    If Slack failed, finding stays 'open' → nudge cron picks it up as fallback.
  if (slackDelivered) {
    await supabase
      .from('patrol_findings')
      .update({ status: 'acknowledged' as const })
      .eq('id', findingId)
  }

  return { sent: slackDelivered, findingId, reason: slackDelivered ? undefined : 'Slack delivery failed — finding left open for nudge cron fallback' }
}

// ─── Batch Message Builder ──────────────────────────────────────────────────

/**
 * Build a combined Slack message for a batch of nudges.
 */
export function buildBatchSlackMessage(batch: NudgeBatch): string {
  const lines: string[] = []
  const hasCritical = batch.items.some((i) => i.priority === 'critical')

  if (hasCritical) {
    lines.push('🚨 *Captain — Urgent Items Needing Attention*\n')
  } else {
    lines.push('📋 *Captain — Items Needing Attention*\n')
  }

  for (const item of batch.items) {
    lines.push(item.message)
    lines.push('')
  }

  lines.push(`_${batch.items.length} item${batch.items.length > 1 ? 's' : ''} • Reply in <${process.env.NEXT_PUBLIC_APP_URL ?? ''}/chat|Captain> to take action_`)

  return lines.join('\n')
}
