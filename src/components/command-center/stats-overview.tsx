'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Clock, AlertTriangle, Layers, Brain } from 'lucide-react'

interface Stats {
  pendingActions: number
  atRiskCommitments: number
  connectedIntegrations: number
  memoriesStored: number
}

const statConfig = [
  {
    key: 'pendingActions' as const,
    label: 'Pending Actions',
    icon: Clock,
    accent: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    ring: 'ring-amber-200/50 dark:ring-amber-800/30',
    alertWhen: (v: number) => v > 0,
  },
  {
    key: 'atRiskCommitments' as const,
    label: 'At-Risk Items',
    icon: AlertTriangle,
    accent: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-50 dark:bg-red-950/30',
    ring: 'ring-red-200/50 dark:ring-red-800/30',
    alertWhen: (v: number) => v > 0,
  },
  {
    key: 'connectedIntegrations' as const,
    label: 'Integrations',
    icon: Layers,
    accent: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    ring: 'ring-blue-200/50 dark:ring-blue-800/30',
    alertWhen: () => false,
  },
  {
    key: 'memoriesStored' as const,
    label: 'Memories',
    icon: Brain,
    accent: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    ring: 'ring-violet-200/50 dark:ring-violet-800/30',
    alertWhen: () => false,
  },
]

export function StatsOverview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const supabase = createClient()

  useEffect(() => {
    async function loadStats() {
      const [actions, commitments, integrations, memories] = await Promise.all([
        supabase.from('actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('commitments').select('id', { count: 'exact', head: true }).in('status', ['at_risk', 'overdue']),
        supabase.from('organization_integrations').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('memory').select('id', { count: 'exact', head: true }),
      ])
      setStats({
        pendingActions: actions.count || 0,
        atRiskCommitments: commitments.count || 0,
        connectedIntegrations: integrations.count || 0,
        memoriesStored: memories.count || 0,
      })
    }
    loadStats()
  }, [supabase])

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
        const isAlert = cfg.alertWhen(value)
        return (
          <div
            key={cfg.key}
            className={`group relative overflow-hidden rounded-xl border border-border/50 bg-card p-4
                       transition-all duration-200 hover:shadow-md hover:border-border cursor-default
                       ${isAlert ? 'ring-1 ' + cfg.ring : ''}`}
          >
            <div className="flex items-start justify-between">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${cfg.bg}`}>
                <Icon className={`h-4 w-4 ${cfg.accent}`} />
              </div>
              {isAlert && (
                <span className="relative flex h-2 w-2">
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${
                    cfg.key === 'atRiskCommitments' ? 'bg-red-400' : 'bg-amber-400'
                  }`} />
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${
                    cfg.key === 'atRiskCommitments' ? 'bg-red-500' : 'bg-amber-500'
                  }`} />
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
