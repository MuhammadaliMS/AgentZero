'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AIStatsBar } from './ai-stats-bar'
import { ActiveOutcomes, type OutcomeWithRuns } from './active-outcomes'
import { ActivityFeed, type ChiefLoopEntry, type DecisionEntry, type TriageEntry } from './activity-feed'

interface AIStats {
  activeOutcomes: number
  stepsToday: number
  decisionsToday: number
  chiefRuns: number
}

export function AIActivityView() {
  const supabase = createClient()
  const [stats, setStats] = useState<AIStats | null>(null)
  const [outcomes, setOutcomes] = useState<OutcomeWithRuns[]>([])
  const [chiefLoops, setChiefLoops] = useState<ChiefLoopEntry[]>([])
  const [decisions, setDecisions] = useState<DecisionEntry[]>([])
  const [triageEvents, setTriageEvents] = useState<TriageEntry[]>([])
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
      ])

      // Count active outcomes
      const outcomeData = (outcomesRes.data || []) as OutcomeWithRuns[]
      const activeCount = outcomeData.filter(o => o.status === 'executing' || o.status === 'planning').length

      setStats({
        activeOutcomes: activeCount,
        stepsToday: stepsCountRes.count || 0,
        decisionsToday: decisionsCountRes.count || 0,
        chiefRuns: chiefCountRes.count || 0,
      })

      setOutcomes(outcomeData)
      setChiefLoops((chiefLoopsRes.data || []) as ChiefLoopEntry[])
      setDecisions((decisionsRes.data || []) as DecisionEntry[])
      setTriageEvents((triageRes.data || []) as TriageEntry[])
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
        <ActivityFeed
          chiefLoops={chiefLoops}
          decisions={decisions}
          triageEvents={triageEvents}
        />
      </div>
    </div>
  )
}
