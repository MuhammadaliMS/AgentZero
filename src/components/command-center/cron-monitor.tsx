'use client'

import { useState } from 'react'
import {
  RefreshCw, Sun, Moon, MessageSquare, Calendar, CalendarSync,
  Bell, Cog, GraduationCap, CheckCircle2, XCircle, Loader2, Clock,
  ChevronDown, ChevronRight, Timer, AlertTriangle, Wrench, Bot, BrainCircuit,
  Layers
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/** Per-step activity shape (matches ExecutionStep from cron-logger) */
export interface StepEntry {
  ts: string
  type: 'tool_call' | 'tool_result' | 'sub_agent_start' | 'sub_agent_end' | 'llm_call'
  name: string
  status?: 'ok' | 'error'
  duration_ms?: number
  input?: string
  output?: string
  error?: string
  tokens?: { in: number; out: number }
}

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
  steps: StepEntry[] | null
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
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'error':
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
  }
}

function StepIcon({ type }: { type: StepEntry['type'] }) {
  switch (type) {
    case 'tool_call':
      return <Wrench className="h-3 w-3 text-blue-500 shrink-0" />
    case 'tool_result':
      return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
    case 'sub_agent_start':
      return <Bot className="h-3 w-3 text-violet-500 shrink-0" />
    case 'sub_agent_end':
      return <Bot className="h-3 w-3 text-violet-400 shrink-0" />
    case 'llm_call':
      return <BrainCircuit className="h-3 w-3 text-amber-500 shrink-0" />
    default:
      return <Cog className="h-3 w-3 text-muted-foreground shrink-0" />
  }
}

function stepLabel(type: StepEntry['type']): string {
  switch (type) {
    case 'tool_call': return 'Tool Call'
    case 'tool_result': return 'Tool Result'
    case 'sub_agent_start': return 'Agent Start'
    case 'sub_agent_end': return 'Agent Done'
    case 'llm_call': return 'LLM Call'
    default: return type
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatStepTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

/** Renders a mini-timeline of execution steps for a single run */
function StepTimeline({ steps }: { steps: StepEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const displayed = showAll ? steps : steps.slice(0, 10)

  return (
    <div className="mt-2 ml-2 border-l-2 border-border/40 pl-3 space-y-1">
      {displayed.map((step, i) => (
        <div key={i} className="flex items-start gap-1.5 py-0.5">
          <StepIcon type={step.type} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">
                {stepLabel(step.type)}
              </span>
              <span className="text-[10px] font-mono text-foreground/80 truncate max-w-[180px]">
                {step.name}
              </span>
              {step.status && (
                <span className={`text-[9px] font-medium ${step.status === 'ok' ? 'text-emerald-500' : 'text-red-500'}`}>
                  {step.status === 'ok' ? '✓' : '✗'}
                </span>
              )}
              {step.duration_ms != null && (
                <span className="text-[9px] text-muted-foreground">
                  {formatDuration(step.duration_ms)}
                </span>
              )}
              {step.tokens && (
                <span className="text-[9px] text-muted-foreground">
                  {step.tokens.in + step.tokens.out} tok
                </span>
              )}
              <span className="text-[9px] text-muted-foreground/50 font-mono">
                {formatStepTime(step.ts)}
              </span>
            </div>
            {step.input && step.type === 'tool_call' && (
              <p className="text-[9px] text-muted-foreground/70 mt-0.5 line-clamp-1 font-mono">
                {step.input}
              </p>
            )}
            {step.output && step.type === 'tool_result' && (
              <p className="text-[9px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                {step.output}
              </p>
            )}
            {step.error && (
              <p className="text-[9px] text-red-400 mt-0.5 line-clamp-1">
                {step.error}
              </p>
            )}
          </div>
        </div>
      ))}
      {steps.length > 10 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="text-[10px] text-blue-500 hover:text-blue-400 ml-4 cursor-pointer"
        >
          Show {steps.length - 10} more steps...
        </button>
      )}
    </div>
  )
}

function CronWorkerRow({ worker, runs }: { worker: string; runs: CronRunEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
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
  const errorCount = runs.filter(r => r.status === 'error' || r.status === 'failed').length
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
            runs.slice(0, 20).map((run) => {
              const stepCount = run.steps?.length ?? 0
              const isRunExpanded = expandedRunId === run.id

              return (
                <div key={run.id} className="py-1.5">
                  <div className="flex items-start gap-2">
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
                        {stepCount > 0 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedRunId(isRunExpanded ? null : run.id)
                            }}
                            className="flex items-center gap-0.5 text-[10px] text-blue-500 hover:text-blue-400 cursor-pointer"
                          >
                            <Layers className="h-2.5 w-2.5" />
                            {stepCount} steps
                            {isRunExpanded ? (
                              <ChevronDown className="h-2.5 w-2.5" />
                            ) : (
                              <ChevronRight className="h-2.5 w-2.5" />
                            )}
                          </button>
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

                  {/* Step timeline */}
                  {isRunExpanded && run.steps && run.steps.length > 0 && (
                    <StepTimeline steps={run.steps} />
                  )}
                </div>
              )
            })
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
  const totalErrors = runs.filter(r => r.status === 'error' || r.status === 'failed').length
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
