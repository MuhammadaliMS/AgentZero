'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'

interface Stats {
  pendingActions: number
  atRiskCommitments: number
  connectedIntegrations: number
  memoriesStored: number
}

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

  if (!stats) return null

  const items = [
    {
      label: 'Pending Actions',
      value: stats.pendingActions,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
      color: stats.pendingActions > 0 ? 'text-orange-600' : 'text-green-600',
    },
    {
      label: 'At-Risk Items',
      value: stats.atRiskCommitments,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
      color: stats.atRiskCommitments > 0 ? 'text-red-600' : 'text-green-600',
    },
    {
      label: 'Integrations',
      value: stats.connectedIntegrations,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      color: 'text-blue-600',
    },
    {
      label: 'Memories',
      value: stats.memoriesStored,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
          <path d="M12 6v6l4 2" />
        </svg>
      ),
      color: 'text-purple-600',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <div className={`shrink-0 ${item.color}`}>{item.icon}</div>
            <div>
              <p className="text-2xl font-bold">{item.value}</p>
              <p className="text-xs text-muted-foreground">{item.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
