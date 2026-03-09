'use client'

import { useState } from 'react'
import {
  RefreshCw, Sun, Moon, MessageSquare, Calendar, CalendarSync,
  Bell, Cog, GraduationCap, CheckCircle2, XCircle, Loader2, Clock,
  ChevronDown, ChevronRight, Timer, AlertTriangle
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export interface CronRunEntry {
  id: string
  worker: string
  trigger: string | null
  status: string
  created_at: string
  completed_at: string | null
  duration_ms: number | null
  output_summary: string | null
  error: string | null
  cost_usd: number | null
}

/** Maps worker names to display metadata */
const CRON_CONFIG: Record<string, {
  label: string
  icon: typeof RefreshCw
  accent: string
  bg: string
  schedule: string
}> = {
  'chief-loop': {
    label: 'Chief Loop',
    icon: RefreshCw,
    accent: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    schedule: 'Every 12h',
  },
  'morning-brief': {
    label: 'Morning Brief',
    icon: Sun,
    accent: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    schedule: 'Daily 4:30PM UTC',
  },
  'eod-wrap': {
    label: 'EOD Wrap',
    icon: Moon,
    accent: 'text-indigo-600 dark:text-indigo-400',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
    schedule: 'Daily 2:30AM UTC',
  },
  'meeting-summarize': {
    label: 'Meeting Summarize',
    icon: MessageSquare,
    accent: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    schedule: 'Every 2 min',
  },
  'meeting-sync': {
    label: 'Meeting Sync',
    icon: CalendarSync,
    accent: 'text-cyan-600 dark:text-cyan-400',
    bg: 'bg-cyan-50 dark:bg-cyan-950/30',
    schedule: 'Every 5 min',
  },
  'nudge': {
    label: 'Nudge',
    icon: Bell,
    accent: 'text-pink-600 dark:text-pink-400',
    bg: 'bg-pink-50 dark:bg-pink-950/30',
    schedule: '3x daily',
  },
  'outcome-tick': {
    label: 'Outcome Tick',
    icon: Cog,
    accent: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    schedule: 'Every 5 min',
  },
  'weekly-tuning': {
    label: 'Weekly Tuning',
    icon: GraduationCap,
    accent: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-50 dark:bg-orange-950/30',
    schedule: 'Sundays',
  },
}

const ALL_WORKERS = Object.keys(CRON_CONFIG)

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'ok':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'error':
      return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'partial':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function CronWorkerRow({ worker, runs }: { worker: string; runs: CronRunEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const config = CRON_CONFIG[worker] || {
    label: worker,
    icon: Cog,
    accent: 'text-muted-foreground',
    bg: 'bg-muted/30',
    schedule: '—',
  }

  const Icon = config.icon
  const latestRun = runs[0] || null
  const runsToday = runs.length
  const errorCount = runs.filter(r => r.status === 'error').length
  const avgDuration = runs.length > 0
    ? Math.round(runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / runs.length)
    : null

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden transition-all duration-200 hover:border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 text-left cursor-pointer hover:bg-muted/30 transition-colors"
      >
        {/* Icon */}
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${config.bg} shrink-0`}>
          <Icon className={`h-4 w-4 ${config.accent}`} />
        </div>

        {/* Label + schedule */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">{config.label}</h4>
            <span className="text-[10px] text-muted-foreground">{config.schedule}</span>
          </div>
          {latestRun ? (
            <div className="flex items-center gap-2 mt-0.5">
              <StatusIcon status={latestRun.status} />
              <span className="text-[10px] text-muted-foreground">
                {timeAgo(latestRun.created_at)}
              </span>
              {latestRun.duration_ms != null && (
                <>
                  <span className="text-[10px] text-muted-foreground/40">·</span>
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <Timer className="h-2.5 w-2.5" />
                    {formatDuration(latestRun.duration_ms)}
                  </span>
                </>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">No runs today</p>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            <p className="text-sm font-semibold">{runsToday}</p>
            <p className="text-[9px] text-muted-foreground">runs</p>
          </div>
          {errorCount > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              {errorCount} err
            </Badge>
          )}
          {avgDuration != null && (
            <div className="text-right hidden sm:block">
              <p className="text-xs font-medium text-muted-foreground">{formatDuration(avgDuration)}</p>
              <p className="text-[9px] text-muted-foreground">avg</p>
            </div>
          )}
        </div>

        {/* Chevron */}
        <div className="shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded run list */}
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3 space-y-1.5">
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic text-center py-2">No runs today</p>
          ) : (
            runs.slice(0, 20).map((run) => (
              <div key={run.id} className="flex items-start gap-2 py-1.5">
                <StatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {formatTime(run.created_at)}
                    </span>
                    {run.duration_ms != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatDuration(run.duration_ms)}
                      </span>
                    )}
                    {run.cost_usd != null && run.cost_usd > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        ${run.cost_usd.toFixed(4)}
                      </span>
                    )}
                  </div>
                  {run.output_summary && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                      {run.output_summary}
                    </p>
                  )}
                  {run.error && (
                    <p className="text-[10px] text-red-500 mt-0.5 line-clamp-2">
                      {run.error}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function CronMonitor({ runs }: { runs: CronRunEntry[] }) {
  // Group runs by worker
  const runsByWorker = new Map<string, CronRunEntry[]>()
  for (const worker of ALL_WORKERS) {
    runsByWorker.set(worker, [])
  }
  for (const run of runs) {
    const existing = runsByWorker.get(run.worker) || []
    existing.push(run)
    runsByWorker.set(run.worker, existing)
  }

  // Sort each group by created_at descending
  for (const [, workerRuns] of runsByWorker) {
    workerRuns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }

  // Count totals
  const totalRuns = runs.length
  const totalErrors = runs.filter(r => r.status === 'error').length
  const activeWorkers = [...runsByWorker.entries()].filter(([, r]) => r.length > 0).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Calendar className="h-4 w-4 text-blue-500" />
          Cron Jobs
          <span className="text-xs font-normal text-muted-foreground">
            ({totalRuns} runs today · {activeWorkers}/{ALL_WORKERS.length} active)
          </span>
        </h3>
        {totalErrors > 0 && (
          <Badge variant="destructive" className="text-[10px]">
            {totalErrors} errors
          </Badge>
        )}
      </div>
      <div className="space-y-2">
        {ALL_WORKERS.map((worker) => (
          <CronWorkerRow
            key={worker}
            worker={worker}
            runs={runsByWorker.get(worker) || []}
          />
        ))}
      </div>
    </div>
  )
}
