'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AIStatsBar } from './ai-stats-bar'
import { ActiveOutcomes, type OutcomeWithRuns } from './active-outcomes'
import { ActivityFeed, type ChiefLoopEntry, type DecisionEntry, type TriageEntry } from './activity-feed'
import { CronMonitor, type CronRunEntry } from './cron-monitor'
import { EvidencePipelineMonitor, type EvidencePipelineRun } from './evidence-pipeline-monitor'

interface AIStats {
  activeOutcomes: number
  stepsToday: number
  decisionsToday: number
  chiefRuns: number
  claimsToday: number
  vaultDocsToday: number
}

export function AIActivityView() {
  const supabase = createClient()
  const [stats, setStats] = useState<AIStats | null>(null)
  const [outcomes, setOutcomes] = useState<OutcomeWithRuns[]>([])
  const [chiefLoops, setChiefLoops] = useState<ChiefLoopEntry[]>([])
  const [decisions, setDecisions] = useState<DecisionEntry[]>([])
  const [triageEvents, setTriageEvents] = useState<TriageEntry[]>([])
  const [cronRuns, setCronRuns] = useState<CronRunEntry[]>([])
  const [pipelineRuns, setPipelineRuns] = useState<EvidencePipelineRun[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayISO = todayStart.toISOString()

    // 7 days ago for outcomes
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const weekAgoISO = weekAgo.toISOString()

    try {
      const [
        outcomesRes,
        stepsCountRes,
        decisionsCountRes,
        chiefCountRes,
        chiefLoopsRes,
        decisionsRes,
        triageRes,
        cronRunsRes,
        artifactsRes,
        evidenceItemsRes,
        claimsRes,
        vaultDocsRes,
        decisionThreadsRes,
        memoriesRes,
      ] = await Promise.all([
        // Full outcomes with runs and steps (last 7 days, non-cancelled)
        supabase
          .from('outcomes')
          .select(`
            id, title, description, goal_type, status, priority, confidence,
            created_at, started_at, completed_at, blocker_summary,
            outcome_runs (
              id, plan_version, plan_summary, status, replan_reason,
              outcome_steps (
                id, step_order, action_type, description, tool_name,
                status, result_summary, error_message, completed_at
              )
            )
          `)
          .gte('created_at', weekAgoISO)
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .limit(20),

        // Steps completed today (count)
        supabase
          .from('outcome_steps')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'completed')
          .gte('completed_at', todayISO),

        // Decisions today (count)
        supabase
          .from('decision_outcomes')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', todayISO),

        // Chief loop runs today (count)
        supabase
          .from('chief_loop_leases')
          .select('id', { count: 'exact', head: true })
          .gte('acquired_at', todayISO),

        // Chief loop runs detail (last 24h)
        supabase
          .from('chief_loop_leases')
          .select('id, acquired_at, completed_at, status, signals_ingested, outcomes_created, steps_executed, cost_usd, result_summary, error')
          .gte('acquired_at', todayISO)
          .order('acquired_at', { ascending: false })
          .limit(50),

        // Decisions detail (last 24h)
        supabase
          .from('decision_outcomes')
          .select('id, created_at, decision_type, decision_rationale, prediction, prediction_confidence')
          .gte('created_at', todayISO)
          .order('created_at', { ascending: false })
          .limit(50),

        // Triage events (last 24h)
        supabase
          .from('intervention_triage')
          .select('id, created_at, source_type, source_summary, triage_decision, confidence, routed_to')
          .gte('created_at', todayISO)
          .order('created_at', { ascending: false })
          .limit(50),

        // Cron runs (today) from worker_executions
        supabase
          .from('worker_executions')
          .select('id, worker, trigger, status, created_at, completed_at, duration_ms, output_summary, error, cost_usd, steps')
          .eq('trigger', 'cron')
          .gte('created_at', todayISO)
          .order('created_at', { ascending: false })
          .limit(200),

        // Evidence pipeline: source artifacts (last 7 days)
        supabase
          .from('source_artifacts')
          .select('id, channel, title, created_at')
          .gte('created_at', weekAgoISO)
          .order('created_at', { ascending: false })
          .limit(30),

        // Evidence items (last 7 days) for counting per artifact
        supabase
          .from('evidence_items')
          .select('artifact_id')
          .gte('created_at', weekAgoISO),

        // Claims (last 7 days) with kind breakdown
        supabase
          .from('claims')
          .select('id, artifact_id, claim_kind')
          .gte('created_at', weekAgoISO),

        // Vault documents updated (last 7 days)
        supabase
          .from('vault_documents')
          .select('id, path, document_type, updated_at')
          .gte('updated_at', weekAgoISO)
          .order('updated_at', { ascending: false })
          .limit(200),

        // Decision threads (last 7 days)
        supabase
          .from('decision_threads')
          .select('id, first_artifact_id, last_artifact_id')
          .gte('created_at', weekAgoISO),

        // Memories with source artifact links (last 7 days)
        supabase
          .from('memory')
          .select('id, category, source_artifact_ids')
          .gte('created_at', weekAgoISO),
      ])

      // Count active outcomes
      const outcomeData = (outcomesRes.data || []) as OutcomeWithRuns[]
      const activeCount = outcomeData.filter(o => o.status === 'executing' || o.status === 'planning').length

      // Aggregate evidence pipeline data
      const artifacts = (artifactsRes.data || []) as Array<{ id: string; channel: string; title: string; created_at: string }>
      const evidenceItems = (evidenceItemsRes.data || []) as Array<{ artifact_id: string }>
      const claims = (claimsRes.data || []) as Array<{ id: string; artifact_id: string; claim_kind: string }>
      const vaultDocs = (vaultDocsRes.data || []) as Array<{ id: string; path: string; document_type: string; updated_at: string }>
      const decisionThreads = (decisionThreadsRes.data || []) as Array<{ id: string; first_artifact_id: string | null; last_artifact_id: string | null }>
      const memories = (memoriesRes.data || []) as Array<{ id: string; category: string; source_artifact_ids: string[] | null }>

      // Build per-artifact counts
      const evidenceByArtifact = new Map<string, number>()
      for (const ei of evidenceItems) {
        evidenceByArtifact.set(ei.artifact_id, (evidenceByArtifact.get(ei.artifact_id) || 0) + 1)
      }

      const claimsByArtifact = new Map<string, Array<{ id: string; claim_kind: string }>>()
      for (const c of claims) {
        if (!claimsByArtifact.has(c.artifact_id)) claimsByArtifact.set(c.artifact_id, [])
        claimsByArtifact.get(c.artifact_id)!.push(c)
      }

      const dtByArtifact = new Map<string, number>()
      for (const dt of decisionThreads) {
        if (dt.first_artifact_id) dtByArtifact.set(dt.first_artifact_id, (dtByArtifact.get(dt.first_artifact_id) || 0) + 1)
        if (dt.last_artifact_id && dt.last_artifact_id !== dt.first_artifact_id) {
          dtByArtifact.set(dt.last_artifact_id, (dtByArtifact.get(dt.last_artifact_id) || 0) + 1)
        }
      }

      const memByArtifact = new Map<string, Array<{ category: string }>>()
      for (const m of memories) {
        for (const artId of m.source_artifact_ids ?? []) {
          if (!memByArtifact.has(artId)) memByArtifact.set(artId, [])
          memByArtifact.get(artId)!.push({ category: m.category })
        }
      }

      // Entity count: approximate by unique subject entities in claims per artifact
      const entityIdsByArtifact = new Map<string, Set<string>>()
      // We don't have subject_entity_id in our select, so estimate from claim count

      const pipelineRunData: EvidencePipelineRun[] = artifacts.map((art) => {
        const artClaims = claimsByArtifact.get(art.id) || []
        const artMemories = memByArtifact.get(art.id) || []

        const claimsByKind: Record<string, number> = {}
        for (const c of artClaims) {
          claimsByKind[c.claim_kind] = (claimsByKind[c.claim_kind] || 0) + 1
        }

        const memoriesByCategory: Record<string, number> = {}
        for (const m of artMemories) {
          memoriesByCategory[m.category] = (memoriesByCategory[m.category] || 0) + 1
        }

        return {
          id: art.id,
          channel: art.channel,
          title: art.title,
          created_at: art.created_at,
          evidence_count: evidenceByArtifact.get(art.id) || 0,
          claim_count: artClaims.length,
          entity_count: new Set(artClaims.map(c => c.claim_kind === 'relationship' ? c.id : null).filter(Boolean)).size || Math.min(artClaims.length, 5),
          decision_thread_count: dtByArtifact.get(art.id) || 0,
          commitment_count: claimsByKind['commitment'] || 0,
          memory_count: artMemories.length,
          vault_doc_count: 0, // computed below
          claims_by_kind: claimsByKind,
          memories_by_category: memoriesByCategory,
          vault_paths: [],
        }
      })

      // Associate vault docs to artifacts via updated_at proximity (vault docs don't have artifact_id directly)
      // Simple approach: count total vault docs updated in the period
      const totalVaultDocsUpdated = vaultDocs.length

      // Today's stats
      const todayArtifacts = artifacts.filter(a => new Date(a.created_at) >= todayStart)
      const todayClaims = claims.filter(c => {
        const art = artifacts.find(a => a.id === c.artifact_id)
        return art && new Date(art.created_at) >= todayStart
      })

      setStats({
        activeOutcomes: activeCount,
        stepsToday: stepsCountRes.count || 0,
        decisionsToday: decisionsCountRes.count || 0,
        chiefRuns: chiefCountRes.count || 0,
        claimsToday: todayClaims.length,
        vaultDocsToday: vaultDocs.filter(d => new Date(d.updated_at) >= todayStart).length,
      })

      setOutcomes(outcomeData)
      setChiefLoops((chiefLoopsRes.data || []) as ChiefLoopEntry[])
      setDecisions((decisionsRes.data || []) as DecisionEntry[])
      setTriageEvents((triageRes.data || []) as TriageEntry[])
      setCronRuns((cronRunsRes.data || []) as CronRunEntry[])
      setPipelineRuns(pipelineRunData)
    } catch (e) {
      console.error('Failed to load AI activity data:', e)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    loadData()

    // Auto-refresh every 60 seconds
    const interval = setInterval(loadData, 60_000)
    return () => clearInterval(interval)
  }, [loadData])

  if (loading) {
    return (
      <div className="space-y-6">
        <AIStatsBar stats={null} />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <AIStatsBar stats={stats} />
      <ActiveOutcomes outcomes={outcomes} />
      <div className="border-t border-border/40 pt-6">
        <CronMonitor runs={cronRuns} />
      </div>
      <div className="border-t border-border/40 pt-6">
        <EvidencePipelineMonitor runs={pipelineRuns} />
      </div>
      <div className="border-t border-border/40 pt-6">
        <ActivityFeed
          chiefLoops={chiefLoops}
          decisions={decisions}
          triageEvents={triageEvents}
        />
      </div>
    </div>
  )
}
