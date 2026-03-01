'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ActionCard } from './action-card'
import { CommitmentCard } from './commitment-card'
import { BriefCard } from './brief-card'
import { Skeleton } from '@/components/ui/skeleton'
import type { Database } from '@/types/database'

type Action = Database['public']['Tables']['actions']['Row']
type Commitment = Database['public']['Tables']['commitments']['Row']
type Brief = Database['public']['Tables']['briefs']['Row']

interface DailyViewData {
  pendingActions: Action[]
  atRiskCommitments: Commitment[]
  latestBrief: Brief | null
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

    // Refresh data
    fetchData()
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-8">
      {/* Latest Brief */}
      {data.latestBrief && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Latest Brief</h2>
          <BriefCard brief={data.latestBrief} />
        </section>
      )}

      {/* Pending Actions */}
      {data.pendingActions.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">
            Pending Actions
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({data.pendingActions.length})
            </span>
          </h2>
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
          <h2 className="mb-3 text-lg font-semibold">
            Commitments
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({data.atRiskCommitments.length})
            </span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.atRiskCommitments.map((commitment) => (
              <CommitmentCard key={commitment.id} commitment={commitment} />
            ))}
          </div>
        </section>
      )}

      {/* Empty State */}
      {data.pendingActions.length === 0 &&
        data.atRiskCommitments.length === 0 &&
        !data.latestBrief && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-green-600 dark:text-green-400">
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="10" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">All clear</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              No pending actions or at-risk commitments. Nice work.
            </p>
          </div>
        )}
    </div>
  )
}
