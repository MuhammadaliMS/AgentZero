'use client'

import { Target, Zap, Brain, RefreshCw } from 'lucide-react'

interface AIStats {
  activeOutcomes: number
  stepsToday: number
  decisionsToday: number
  chiefRuns: number
}

const statConfig = [
  {
    key: 'activeOutcomes' as const,
    label: 'Active Outcomes',
    icon: Target,
    accent: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    ring: 'ring-violet-200/50 dark:ring-violet-800/30',
    pulse: (v: number) => v > 0,
  },
  {
    key: 'stepsToday' as const,
    label: 'Steps Today',
    icon: Zap,
    accent: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    ring: 'ring-blue-200/50 dark:ring-blue-800/30',
    pulse: () => false,
  },
  {
    key: 'decisionsToday' as const,
    label: 'Decisions Today',
    icon: Brain,
    accent: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    ring: 'ring-amber-200/50 dark:ring-amber-800/30',
    pulse: () => false,
  },
  {
    key: 'chiefRuns' as const,
    label: 'Chief Runs',
    icon: RefreshCw,
    accent: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    ring: 'ring-emerald-200/50 dark:ring-emerald-800/30',
    pulse: () => false,
  },
]

export function AIStatsBar({ stats }: { stats: AIStats | null }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-xl bg-muted/40" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {statConfig.map((cfg) => {
        const Icon = cfg.icon
        const value = stats[cfg.key]
        const showPulse = cfg.pulse(value)
        return (
          <div
            key={cfg.key}
            className={`group relative overflow-hidden rounded-xl border border-border/50 bg-card p-4
                       transition-all duration-200 hover:shadow-md hover:border-border cursor-default
                       ${showPulse ? 'ring-1 ' + cfg.ring : ''}`}
          >
            <div className="flex items-start justify-between">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${cfg.bg}`}>
                <Icon className={`h-4 w-4 ${cfg.accent}`} />
              </div>
              {showPulse && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 bg-violet-400" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
                </span>
              )}
            </div>
            <div className="mt-3">
              <p className="text-2xl font-bold tracking-tight">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{cfg.label}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
