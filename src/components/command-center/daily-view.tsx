'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ActionCard } from './action-card'
import { CommitmentCard } from './commitment-card'
import { BriefCard } from './brief-card'
import { CheckCircle, Zap, Shield, FileText } from 'lucide-react'
import type { Database } from '@/types/database'

type Action = Database['public']['Tables']['actions']['Row']
type Commitment = Database['public']['Tables']['commitments']['Row']
type Brief = Database['public']['Tables']['briefs']['Row']

interface DailyViewData {
  pendingActions: Action[]
  atRiskCommitments: Commitment[]
  latestBrief: Brief | null
}

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-4 w-4 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-28 rounded bg-muted/60 animate-pulse" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-32 rounded-xl bg-muted/40 animate-pulse" />
        ))}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  count,
  accent,
}: {
  icon: React.ElementType
  title: string
  count?: number
  accent: string
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`h-4 w-4 ${accent}`} />
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {count !== undefined && count > 0 && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  )
}

export function DailyView() {
  const [data, setData] = useState<DailyViewData | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [actionsRes, commitmentsRes, briefRes] = await Promise.all([
        supabase
          .from('actions')
          .select('*')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('commitments')
          .select('*')
          .in('status', ['at_risk', 'overdue', 'active'])
          .order('due_date', { ascending: true })
          .limit(10),
        supabase
          .from('briefs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .single(),
      ])

      setData({
        pendingActions: (actionsRes.data || []) as Action[],
        atRiskCommitments: (commitmentsRes.data || []) as Commitment[],
        latestBrief: briefRes.data as Brief | null,
      })
    } catch {
      // Silently handle errors on initial load
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleResolveAction = async (
    actionId: string,
    resolution: 'approved' | 'rejected' | 'deferred'
  ) => {
    await supabase
      .from('actions')
      .update({
        status: resolution,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', actionId)

    fetchData()
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <SectionSkeleton />
        <SectionSkeleton />
        <div className="h-40 rounded-xl bg-muted/40 animate-pulse" />
      </div>
    )
  }

  if (!data) return null

  const isEmpty =
    data.pendingActions.length === 0 &&
    data.atRiskCommitments.length === 0 &&
    !data.latestBrief

  return (
    <div className="space-y-8">
      {/* Latest Brief */}
      {data.latestBrief && (
        <section>
          <SectionHeader
            icon={FileText}
            title="Latest Brief"
            accent="text-blue-600 dark:text-blue-400"
          />
          <BriefCard brief={data.latestBrief} />
        </section>
      )}

      {/* Pending Actions */}
      {data.pendingActions.length > 0 && (
        <section>
          <SectionHeader
            icon={Zap}
            title="Pending Actions"
            count={data.pendingActions.length}
            accent="text-amber-600 dark:text-amber-400"
          />
          <div className="grid gap-3 md:grid-cols-2">
            {data.pendingActions.map((action) => (
              <ActionCard
                key={action.id}
                action={action}
                onResolve={handleResolveAction}
              />
            ))}
          </div>
        </section>
      )}

      {/* At-Risk Commitments */}
      {data.atRiskCommitments.length > 0 && (
        <section>
          <SectionHeader
            icon={Shield}
            title="Commitments"
            count={data.atRiskCommitments.length}
            accent="text-red-600 dark:text-red-400"
          />
          <div className="grid gap-3 md:grid-cols-2">
            {data.atRiskCommitments.map((commitment) => (
              <CommitmentCard key={commitment.id} commitment={commitment} />
            ))}
          </div>
        </section>
      )}

      {/* Empty State */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
            <CheckCircle className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h3 className="text-base font-semibold">All clear</h3>
          <p className="mt-1.5 max-w-xs text-sm text-muted-foreground leading-relaxed">
            No pending actions or at-risk commitments right now. You&apos;re on track.
          </p>
        </div>
      )}
    </div>
  )
}
