/**
 * Cross-Worker Brief Synthesizer — Gathers structured data from each
 * worker domain (Cole, Rhea, Eve, Patrol) and builds enriched prompts.
 *
 * All pure DB queries — zero LLM calls. The enriched prompt is then
 * passed to runCaptain() for final brief generation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ColeView {
  activeCount: number
  atRiskCount: number
  overdueCount: number
  completedTodayCount: number
  topDeadlines: Array<{
    title: string
    due_date: string
    priority: string
    risk_score: number
    status: string
  }>
  pendingActionsCount: number
  oldestActionDays: number | null
}

export interface RheaView {
  hasVantaConnection: boolean
  failingControlsCount: number
  topFailingControls: Array<{ title: string; severity: string }>
  complianceFindings: number
}

export interface EveView {
  recentDecisions: Array<{ subject: string; content: string; created_at: string }>
  keyStakeholders: Array<{ name: string; mention_count: number }>
}

export interface PatrolView {
  openFindingsCount: number
  criticalFindings: number
  byType: Record<string, number>
  newSinceYesterday: number
}

export interface InsightsView {
  contradictions: Array<{ summary: string; confidence: number; category: string }>
  patterns: Array<{ summary: string; confidence: number }>
  anomalies: Array<{ summary: string; confidence: number }>
  staleItems: Array<{ summary: string; confidence: number }>
  risks: Array<{ summary: string; confidence: number }>
  totalActive: number
}

export interface OutcomesView {
  active: Array<{ id: string; title: string; status: string; priority: string; progress: string; blockerSummary: string | null }>
  totalActive: number
}

export interface WorkerViews {
  cole: ColeView
  rhea: RheaView
  eve: EveView
  patrol: PatrolView
  insights: InsightsView
  outcomes: OutcomesView
}

export interface BriefMetrics {
  commitments_active: number
  commitments_at_risk: number
  commitments_overdue: number
  actions_pending: number
  controls_failing: number
  patrol_critical: number
  patrol_total: number
}

// ─── Gather Worker Views ────────────────────────────────────────────────────

export async function gatherWorkerViews(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<WorkerViews> {
  const [cole, rhea, eve, patrol, insights, outcomes] = await Promise.all([
    gatherColeView(supabase, orgId),
    gatherRheaView(supabase, orgId),
    gatherEveView(supabase, orgId),
    gatherPatrolView(supabase, orgId),
    gatherInsightsView(supabase, orgId),
    gatherOutcomesView(supabase, orgId),
  ])

  return { cole, rhea, eve, patrol, insights, outcomes }
}

// ─── Cole (Program Management) ──────────────────────────────────────────────

async function gatherColeView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<ColeView> {
  // Commitment counts by status
  const { data: commitments } = await supabase
    .from('commitments')
    .select('id, status, title, due_date, priority, risk_score, completed_at')
    .eq('org_id', orgId)
    .in('status', ['active', 'at_risk', 'overdue', 'completed'])

  const all = commitments ?? []
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const activeCount = all.filter((c) => c.status === 'active').length
  const atRiskCount = all.filter((c) => c.status === 'at_risk').length
  const overdueCount = all.filter((c) => c.status === 'overdue').length
  const completedTodayCount = all.filter(
    (c) => c.status === 'completed' && c.completed_at && new Date(c.completed_at) >= todayStart
  ).length

  // Top deadlines — active/at_risk with due dates, sorted by risk_score desc
  const withDeadlines = all
    .filter((c) => ['active', 'at_risk'].includes(c.status) && c.due_date)
    .sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0))
    .slice(0, 10)
    .map((c) => ({
      title: c.title,
      due_date: c.due_date!,
      priority: c.priority,
      risk_score: c.risk_score ?? 0,
      status: c.status,
    }))

  // Pending actions
  const { data: pendingActions } = await supabase
    .from('actions')
    .select('id, created_at')
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  const pendingActionsCount = pendingActions?.length ?? 0
  let oldestActionDays: number | null = null
  if (pendingActions && pendingActions.length > 0) {
    oldestActionDays = Math.round(
      (Date.now() - new Date(pendingActions[0].created_at).getTime()) / 86_400_000
    )
  }

  return {
    activeCount,
    atRiskCount,
    overdueCount,
    completedTodayCount,
    topDeadlines: withDeadlines,
    pendingActionsCount,
    oldestActionDays,
  }
}

// ─── Rhea (GRC / Compliance) ────────────────────────────────────────────────

async function gatherRheaView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<RheaView> {
  // Check if Vanta is connected
  const { data: vantaIntegration } = await supabase
    .from('organization_integrations')
    .select('is_active, integrations!inner(key)')
    .eq('org_id', orgId)
    .eq('integrations.key', 'vanta')
    .maybeSingle()

  const hasVantaConnection = !!(vantaIntegration as { is_active?: boolean })?.is_active

  // Get compliance-related patrol findings
  const { data: compFindings } = await supabase
    .from('patrol_findings')
    .select('id, title, severity')
    .eq('org_id', orgId)
    .eq('type', 'failing_control')
    .eq('status', 'open')

  const failingControlsCount = compFindings?.length ?? 0
  const topFailingControls = (compFindings ?? [])
    .slice(0, 5)
    .map((f) => ({ title: f.title, severity: f.severity }))

  // Total compliance findings (including stale controls)
  const { count } = await supabase
    .from('patrol_findings')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('type', ['failing_control', 'stale_entity'])
    .eq('status', 'open')

  return {
    hasVantaConnection,
    failingControlsCount,
    topFailingControls,
    complianceFindings: count ?? 0,
  }
}

// ─── Eve (Strategy / Relationships) ─────────────────────────────────────────

async function gatherEveView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<EveView> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // Recent decisions from memory
  const { data: decisions } = await supabase
    .from('memory')
    .select('subject, content, created_at')
    .eq('org_id', orgId)
    .eq('category', 'decision')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(5)

  // High-mention people entities
  const { data: people } = await supabase
    .from('entities')
    .select('name, mention_count')
    .eq('org_id', orgId)
    .eq('entity_type', 'person')
    .order('mention_count', { ascending: false })
    .limit(5)

  return {
    recentDecisions: decisions ?? [],
    keyStakeholders: (people ?? []).map((p) => ({
      name: p.name,
      mention_count: p.mention_count,
    })),
  }
}

// ─── Patrol View ────────────────────────────────────────────────────────────

async function gatherPatrolView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<PatrolView> {
  const { data: findings } = await supabase
    .from('patrol_findings')
    .select('id, type, severity, created_at')
    .eq('org_id', orgId)
    .eq('status', 'open')

  const all = findings ?? []
  const yesterdayCutoff = new Date(Date.now() - 86_400_000).toISOString()

  const byType: Record<string, number> = {}
  let criticalFindings = 0
  let newSinceYesterday = 0

  for (const f of all) {
    byType[f.type] = (byType[f.type] ?? 0) + 1
    if (f.severity === 'critical') criticalFindings++
    if (f.created_at >= yesterdayCutoff) newSinceYesterday++
  }

  return {
    openFindingsCount: all.length,
    criticalFindings,
    byType,
    newSinceYesterday,
  }
}

// ─── Build Enriched Brief Prompt ────────────────────────────────────────────

/**
 * Build a structured prompt with cross-worker data for the brief.
 */
export function buildBriefPrompt(
  type: 'morning' | 'eod',
  views: WorkerViews,
  yesterdayMetrics: BriefMetrics | null,
  userName: string,
  dateLabel: string
): string {
  const sections: string[] = []

  // Header
  if (type === 'morning') {
    sections.push(
      `Generate ${userName}'s morning brief for ${dateLabel}. Use the structured data below to create a crisp, actionable brief (max 300 words).`
    )
  } else {
    sections.push(
      `Generate ${userName}'s end-of-day wrap for ${dateLabel}. Use the structured data below to create a concise summary (max 250 words).`
    )
  }

  sections.push('')

  // ── Program Status (Cole) ──────────────────────────────────────────────
  sections.push('## Program Status')
  sections.push(
    `- Active commitments: ${views.cole.activeCount}`
  )
  sections.push(`- At risk: ${views.cole.atRiskCount}`)
  sections.push(`- Overdue: ${views.cole.overdueCount}`)

  if (type === 'eod') {
    sections.push(`- Completed today: ${views.cole.completedTodayCount}`)
  }

  if (views.cole.topDeadlines.length > 0) {
    sections.push('\nUpcoming deadlines (by risk):')
    for (const d of views.cole.topDeadlines) {
      sections.push(
        `  - "${d.title}" — due ${d.due_date}, ${d.priority} priority, risk ${d.risk_score}/100, status: ${d.status}`
      )
    }
  }

  if (views.cole.pendingActionsCount > 0) {
    sections.push(
      `\nPending actions: ${views.cole.pendingActionsCount}${views.cole.oldestActionDays ? ` (oldest: ${views.cole.oldestActionDays}d)` : ''}`
    )
  }

  // ── Compliance (Rhea) ─────────────────────────────────────────────────
  sections.push('\n## Compliance & Controls')
  if (views.rhea.hasVantaConnection) {
    sections.push(`- Vanta connected: yes`)
    sections.push(`- Failing controls: ${views.rhea.failingControlsCount}`)
    if (views.rhea.topFailingControls.length > 0) {
      for (const c of views.rhea.topFailingControls) {
        sections.push(`  - ${c.title} (${c.severity})`)
      }
    }
  } else {
    sections.push('- Vanta: not connected')
  }
  if (views.rhea.complianceFindings > 0) {
    sections.push(`- Total compliance findings: ${views.rhea.complianceFindings}`)
  }

  // ── Strategic Context (Eve) ───────────────────────────────────────────
  sections.push('\n## Strategic Context')
  if (views.eve.recentDecisions.length > 0) {
    sections.push('Recent decisions (last 7 days):')
    for (const d of views.eve.recentDecisions) {
      sections.push(`  - ${d.subject}: ${d.content.substring(0, 100)}${d.content.length > 100 ? '...' : ''}`)
    }
  } else {
    sections.push('- No recent decisions recorded')
  }

  if (views.eve.keyStakeholders.length > 0) {
    sections.push(
      `\nKey stakeholders: ${views.eve.keyStakeholders.map((s) => `${s.name} (${s.mention_count} mentions)`).join(', ')}`
    )
  }

  // ── Patrol Findings ───────────────────────────────────────────────────
  sections.push('\n## Patrol Findings')
  sections.push(`- Open findings: ${views.patrol.openFindingsCount}`)
  sections.push(`- Critical: ${views.patrol.criticalFindings}`)
  sections.push(`- New since yesterday: ${views.patrol.newSinceYesterday}`)

  if (Object.keys(views.patrol.byType).length > 0) {
    sections.push('By type:')
    for (const [t, count] of Object.entries(views.patrol.byType)) {
      sections.push(`  - ${t}: ${count}`)
    }
  }

  // ── Active Outcomes ─────────────────────────────────────────────────
  if (views.outcomes.totalActive > 0) {
    sections.push('\n## Active Outcomes')
    for (const o of views.outcomes.active) {
      const statusEmoji = o.status === 'executing' ? '▶️' : o.status === 'blocked' ? '⛔' : '📋'
      let line = `- ${statusEmoji} "${o.title}" — ${o.status}, ${o.priority} priority, progress: ${o.progress}`
      if (o.blockerSummary) {
        line += ` | Blocker: ${o.blockerSummary}`
      }
      sections.push(line)
    }
  }

  // ── Knowledge Graph Insights ──────────────────────────────────────────
  if (views.insights.totalActive > 0) {
    sections.push('\n## Knowledge Graph Insights')

    if (views.insights.contradictions.length > 0) {
      for (const c of views.insights.contradictions) {
        sections.push(`- ⚠️ Conflicting info: ${c.summary}. Please clarify.`)
      }
    }

    if (views.insights.risks.length > 0) {
      for (const r of views.insights.risks) {
        sections.push(`- 🚨 Risk detected: ${r.summary}`)
      }
    }

    if (views.insights.anomalies.length > 0) {
      for (const a of views.insights.anomalies) {
        sections.push(`- 📈 Unusual activity: ${a.summary}`)
      }
    }

    if (views.insights.staleItems.length > 0) {
      for (const s of views.insights.staleItems) {
        sections.push(`- 💤 ${s.summary}`)
      }
    }

    if (views.insights.patterns.length > 0) {
      for (const p of views.insights.patterns) {
        sections.push(`- 🔗 FYI: ${p.summary}`)
      }
    }
  }

  // ── vs. Yesterday ────────────────────────────────────────────────────
  if (yesterdayMetrics) {
    const current = extractMetrics(views)
    sections.push('\n## vs. Yesterday')
    sections.push(delta('Active commitments', yesterdayMetrics.commitments_active, current.commitments_active))
    sections.push(delta('At-risk', yesterdayMetrics.commitments_at_risk, current.commitments_at_risk))
    sections.push(delta('Pending actions', yesterdayMetrics.actions_pending, current.actions_pending))
    sections.push(delta('Failing controls', yesterdayMetrics.controls_failing, current.controls_failing))
    sections.push(delta('Critical findings', yesterdayMetrics.patrol_critical, current.patrol_critical))
  }

  // Instructions
  sections.push('\n---')
  if (type === 'morning') {
    sections.push(
      'Lead with the highest-priority items. Include calendar events and emails if accessible. Be crisp and actionable.'
    )
  } else {
    sections.push(
      'Summarize what was accomplished, what carries forward, and preview tomorrow. Be concise.'
    )
  }

  return sections.join('\n')
}

// ─── Insights View ──────────────────────────────────────────────────────────

async function gatherInsightsView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<InsightsView> {
  const { data: activeInsights } = await supabase
    .from('graph_insights')
    .select('insight_type, summary, confidence, category')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .order('confidence', { ascending: false })
    .limit(20)

  const all = activeInsights ?? []

  return {
    contradictions: all
      .filter(i => i.insight_type === 'contradiction')
      .slice(0, 3)
      .map(i => ({ summary: i.summary, confidence: i.confidence, category: i.category ?? 'unknown' })),
    patterns: all
      .filter(i => i.insight_type === 'pattern' || i.insight_type === 'correlation')
      .slice(0, 3)
      .map(i => ({ summary: i.summary, confidence: i.confidence })),
    anomalies: all
      .filter(i => i.insight_type === 'anomaly')
      .slice(0, 3)
      .map(i => ({ summary: i.summary, confidence: i.confidence })),
    staleItems: all
      .filter(i => i.insight_type === 'stale')
      .slice(0, 3)
      .map(i => ({ summary: i.summary, confidence: i.confidence })),
    risks: all
      .filter(i => i.insight_type === 'risk')
      .slice(0, 3)
      .map(i => ({ summary: i.summary, confidence: i.confidence })),
    totalActive: all.length,
  }
}

// ─── Outcomes View ──────────────────────────────────────────────────────────

async function gatherOutcomesView(
  supabase: SupabaseClient<Database>,
  orgId: string
): Promise<OutcomesView> {
  const { data: activeOutcomes } = await supabase
    .from('outcomes')
    .select('id, title, status, priority, blocker_summary')
    .eq('org_id', orgId)
    .in('status', ['planning', 'executing', 'blocked'])
    .order('priority', { ascending: true })
    .limit(20)

  const all = activeOutcomes ?? []

  // For each outcome, compute progress from outcome_steps via active runs
  const active: OutcomesView['active'] = []

  for (const o of all) {
    // Find the active run for this outcome
    const { data: activeRun } = await supabase
      .from('outcome_runs')
      .select('id')
      .eq('outcome_id', o.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    let progress = '0/0'
    if (activeRun) {
      const { data: steps } = await supabase
        .from('outcome_steps')
        .select('id, status')
        .eq('run_id', activeRun.id)

      const totalSteps = steps?.length ?? 0
      const completedSteps = steps?.filter((s) => s.status === 'completed').length ?? 0
      progress = `${completedSteps}/${totalSteps}`
    }

    active.push({
      id: o.id,
      title: o.title,
      status: o.status,
      priority: o.priority,
      progress,
      blockerSummary: o.blocker_summary,
    })
  }

  return {
    active,
    totalActive: all.length,
  }
}

// ─── Extract Metrics ────────────────────────────────────────────────────────

/**
 * Extract key metrics from worker views for storage and next-day comparison.
 */
export function extractMetrics(views: WorkerViews): BriefMetrics {
  return {
    commitments_active: views.cole.activeCount,
    commitments_at_risk: views.cole.atRiskCount,
    commitments_overdue: views.cole.overdueCount,
    actions_pending: views.cole.pendingActionsCount,
    controls_failing: views.rhea.failingControlsCount,
    patrol_critical: views.patrol.criticalFindings,
    patrol_total: views.patrol.openFindingsCount,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function delta(label: string, previous: number, current: number): string {
  const diff = current - previous
  if (diff === 0) return `- ${label}: ${current} (unchanged)`
  const arrow = diff > 0 ? '↑' : '↓'
  return `- ${label}: ${current} (${arrow}${Math.abs(diff)} from yesterday)`
}

/**
 * Get yesterday's brief metrics for comparison.
 */
export async function getYesterdayMetrics(
  supabase: SupabaseClient<Database>,
  userId: string,
  briefType: 'morning' | 'eod'
): Promise<BriefMetrics | null> {
  const yesterday = new Date(Date.now() - 86_400_000)
  const dayStart = yesterday.toISOString().slice(0, 10) + 'T00:00:00'
  const dayEnd = yesterday.toISOString().slice(0, 10) + 'T23:59:59'

  const { data } = await supabase
    .from('briefs')
    .select('metrics')
    .eq('user_id', userId)
    .eq('type', briefType)
    .gte('sent_at', dayStart)
    .lte('sent_at', dayEnd)
    .limit(1)
    .maybeSingle()

  if (!data?.metrics) return null

  const m = data.metrics as Record<string, unknown>
  return {
    commitments_active: (m.commitments_active as number) ?? 0,
    commitments_at_risk: (m.commitments_at_risk as number) ?? 0,
    commitments_overdue: (m.commitments_overdue as number) ?? 0,
    actions_pending: (m.actions_pending as number) ?? 0,
    controls_failing: (m.controls_failing as number) ?? 0,
    patrol_critical: (m.patrol_critical as number) ?? 0,
    patrol_total: (m.patrol_total as number) ?? 0,
  }
}
