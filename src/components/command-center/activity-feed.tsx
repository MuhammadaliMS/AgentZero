'use client'

import { RefreshCw, Brain, Filter, Target, Activity } from 'lucide-react'

export interface ChiefLoopEntry {
  id: string
  acquired_at: string
  completed_at: string | null
  status: string
  signals_ingested: number | null
  outcomes_created: number | null
  steps_executed: number | null
  cost_usd: number | null
  result_summary: string | null
  error: string | null
}

export interface DecisionEntry {
  id: string
  created_at: string
  decision_type: string
  decision_rationale: string | null
  prediction: string | null
  prediction_confidence: number | null
}

export interface TriageEntry {
  id: string
  created_at: string
  source_type: string
  source_summary: string
  triage_decision: string
  confidence: number
  routed_to: string | null
}

type FeedItem =
  | { type: 'chief_loop'; timestamp: string; data: ChiefLoopEntry }
  | { type: 'decision'; timestamp: string; data: DecisionEntry }
  | { type: 'triage'; timestamp: string; data: TriageEntry }

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatHourGroup(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric' })
}

function FeedItemCard({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'chief_loop': {
      const d = item.data
      return (
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/30 shrink-0 mt-0.5">
            <RefreshCw className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium">Chief Loop Run</p>
              <span className="text-[10px] text-muted-foreground">{formatTime(item.timestamp)}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {d.signals_ingested != null && (
                <span className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">{d.signals_ingested}</span> signals
                </span>
              )}
              {d.outcomes_created != null && d.outcomes_created > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">{d.outcomes_created}</span> outcomes created
                </span>
              )}
              {d.steps_executed != null && d.steps_executed > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">{d.steps_executed}</span> steps executed
                </span>
              )}
              {d.cost_usd != null && (
                <span className="text-[10px] text-muted-foreground">
                  ${d.cost_usd.toFixed(4)}
                </span>
              )}
            </div>
            {d.error && (
              <p className="text-[10px] text-red-500 mt-1 line-clamp-1">{d.error}</p>
            )}
            {d.result_summary && !d.error && (
              <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{d.result_summary}</p>
            )}
          </div>
        </div>
      )
    }

    case 'decision': {
      const d = item.data
      return (
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/30 shrink-0 mt-0.5">
            <Brain className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium capitalize">{d.decision_type.replace(/_/g, ' ')}</p>
              <span className="text-[10px] text-muted-foreground">{formatTime(item.timestamp)}</span>
            </div>
            {d.decision_rationale && (
              <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{d.decision_rationale}</p>
            )}
            {d.prediction && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Prediction: {d.prediction}
                {d.prediction_confidence != null && (
                  <span className="ml-1 opacity-60">({Math.round(d.prediction_confidence * 100)}%)</span>
                )}
              </p>
            )}
          </div>
        </div>
      )
    }

    case 'triage': {
      const d = item.data
      return (
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 dark:bg-sky-950/30 shrink-0 mt-0.5">
            <Filter className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium capitalize">{d.triage_decision.replace(/_/g, ' ')}</p>
              <span className="text-[10px] text-muted-foreground">{formatTime(item.timestamp)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{d.source_summary}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground capitalize">{d.source_type.replace(/_/g, ' ')}</span>
              {d.routed_to && (
                <span className="text-[10px] text-muted-foreground">→ {d.routed_to}</span>
              )}
            </div>
          </div>
        </div>
      )
    }
  }
}

interface ActivityFeedProps {
  chiefLoops: ChiefLoopEntry[]
  decisions: DecisionEntry[]
  triageEvents: TriageEntry[]
}

export function ActivityFeed({ chiefLoops, decisions, triageEvents }: ActivityFeedProps) {
  // Merge all items into a single sorted feed
  const feedItems: FeedItem[] = [
    ...chiefLoops.map(d => ({ type: 'chief_loop' as const, timestamp: d.acquired_at, data: d })),
    ...decisions.map(d => ({ type: 'decision' as const, timestamp: d.created_at, data: d })),
    ...triageEvents.map(d => ({ type: 'triage' as const, timestamp: d.created_at, data: d })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  if (feedItems.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/50 bg-card/50 p-8 text-center">
        <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto" />
        <p className="text-sm text-muted-foreground mt-3">No AI activity yet today</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Activity from chief loops, decisions, and triage will appear here</p>
      </div>
    )
  }

  // Group by hour
  const groups = new Map<string, FeedItem[]>()
  for (const item of feedItems) {
    const d = new Date(item.timestamp)
    // Round to the hour
    const hourKey = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toISOString()
    const existing = groups.get(hourKey) || []
    existing.push(item)
    groups.set(hourKey, existing)
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Activity className="h-4 w-4 text-blue-500" />
        Activity Feed
        <span className="text-xs font-normal text-muted-foreground">({feedItems.length})</span>
      </h3>
      <div className="space-y-5">
        {Array.from(groups.entries()).map(([hourKey, items]) => (
          <div key={hourKey}>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
              {formatHourGroup(hourKey)}
            </p>
            <div className="space-y-3 pl-1">
              {items.map((item) => (
                <FeedItemCard key={`${item.type}-${item.data.id}`} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
