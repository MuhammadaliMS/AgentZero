'use client'

import { useState } from 'react'
import { Target, ChevronDown, ChevronRight, CheckCircle2, Loader2, Circle, XCircle, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface OutcomeStep {
  id: string
  step_order: number
  action_type: string
  description: string
  tool_name: string | null
  status: string
  result_summary: string | null
  error_message: string | null
  completed_at: string | null
}

interface OutcomeRun {
  id: string
  plan_version: number
  plan_summary: string | null
  status: string
  replan_reason: string | null
  outcome_steps: OutcomeStep[]
}

export interface OutcomeWithRuns {
  id: string
  title: string
  description: string | null
  goal_type: string
  status: string
  priority: string
  confidence: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  blocker_summary: string | null
  outcome_runs: OutcomeRun[]
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  planning: { label: 'Planning', variant: 'secondary' },
  executing: { label: 'Executing', variant: 'default' },
  blocked: { label: 'Blocked', variant: 'destructive' },
  completed: { label: 'Completed', variant: 'outline' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
}

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'executing':
    case 'in_progress':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'waiting':
    case 'waiting_approval':
      return <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
  }
}

function OutcomeCard({ outcome }: { outcome: OutcomeWithRuns }) {
  const [expanded, setExpanded] = useState(false)

  // Get the latest run
  const latestRun = outcome.outcome_runs
    .sort((a, b) => b.plan_version - a.plan_version)[0] || null

  const steps = latestRun?.outcome_steps
    .sort((a, b) => a.step_order - b.step_order) || []

  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = steps.length
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

  const statusCfg = statusConfig[outcome.status] || { label: outcome.status, variant: 'outline' as const }

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden transition-all duration-200 hover:border-border">
      {/* Outcome header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 p-4 text-left cursor-pointer hover:bg-muted/30 transition-colors"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/30 shrink-0 mt-0.5">
          <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-medium truncate">{outcome.title}</h4>
            <Badge variant={statusCfg.variant} className="text-[10px] px-1.5 py-0">
              {statusCfg.label}
            </Badge>
          </div>
          {outcome.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{outcome.description}</p>
          )}
          {/* Progress bar */}
          {totalSteps > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-muted/60 overflow-hidden">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground font-medium shrink-0">
                {completedSteps}/{totalSteps}
              </span>
            </div>
          )}
        </div>
        <div className="shrink-0 mt-1">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded step list */}
      {expanded && steps.length > 0 && (
        <div className="border-t border-border/40 px-4 py-3 space-y-2">
          {latestRun?.plan_summary && (
            <p className="text-xs text-muted-foreground italic mb-3 px-1">
              {latestRun.plan_summary}
            </p>
          )}
          {steps.map((step) => (
            <div key={step.id} className="flex items-start gap-2 py-1.5">
              <StepStatusIcon status={step.status} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium leading-tight">{step.description}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {step.tool_name && (
                    <span className="text-[10px] text-muted-foreground font-mono bg-muted/50 px-1 rounded">
                      {step.tool_name}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground capitalize">{step.action_type.replace('_', ' ')}</span>
                </div>
                {step.error_message && (
                  <p className="text-[10px] text-red-500 mt-0.5 line-clamp-2">{step.error_message}</p>
                )}
                {step.result_summary && step.status === 'completed' && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{step.result_summary}</p>
                )}
              </div>
            </div>
          ))}
          {outcome.blocker_summary && (
            <div className="mt-2 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/30 p-2">
              <p className="text-[10px] font-medium text-red-600 dark:text-red-400">Blocked</p>
              <p className="text-[10px] text-red-600/80 dark:text-red-400/80 mt-0.5">{outcome.blocker_summary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ActiveOutcomes({ outcomes }: { outcomes: OutcomeWithRuns[] }) {
  if (outcomes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/50 bg-card/50 p-8 text-center">
        <Target className="h-8 w-8 text-muted-foreground/30 mx-auto" />
        <p className="text-sm text-muted-foreground mt-3">No active outcomes</p>
        <p className="text-xs text-muted-foreground/60 mt-1">The AI will create outcomes when it identifies goals to pursue</p>
      </div>
    )
  }

  // Sort: executing first, then planning, then blocked, then completed/failed
  const sortOrder: Record<string, number> = { executing: 0, planning: 1, blocked: 2, completed: 3, failed: 4, cancelled: 5 }
  const sorted = [...outcomes].sort((a, b) => (sortOrder[a.status] ?? 99) - (sortOrder[b.status] ?? 99))

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Target className="h-4 w-4 text-violet-500" />
        Outcomes
        <span className="text-xs font-normal text-muted-foreground">({outcomes.length})</span>
      </h3>
      <div className="space-y-2">
        {sorted.map((outcome) => (
          <OutcomeCard key={outcome.id} outcome={outcome} />
        ))}
      </div>
    </div>
  )
}
