'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { Clock, AlertTriangle, Layers, Brain } from 'lucide-react'

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
      icon: <Clock className="h-[18px] w-[18px]" />,
      color: stats.pendingActions > 0 ? 'text-orange-600' : 'text-green-600',
    },
    {
      label: 'At-Risk Items',
      value: stats.atRiskCommitments,
      icon: <AlertTriangle className="h-[18px] w-[18px]" />,
      color: stats.atRiskCommitments > 0 ? 'text-red-600' : 'text-green-600',
    },
    {
      label: 'Integrations',
      value: stats.connectedIntegrations,
      icon: <Layers className="h-[18px] w-[18px]" />,
      color: 'text-blue-600',
    },
    {
      label: 'Memories',
      value: stats.memoriesStored,
      icon: <Brain className="h-[18px] w-[18px]" />,
      color: 'text-purple-600',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} className="shadow-sm hover:shadow-md transition-all">
          <CardContent className="flex items-center gap-3 p-4">
            <div className={`shrink-0 rounded-lg bg-primary/10 p-2 text-primary ${item.color}`}>
              {item.icon}
            </div>
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
