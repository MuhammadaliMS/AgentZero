'use client'

import { DailyView } from '@/components/command-center/daily-view'
import { StatsOverview } from '@/components/command-center/stats-overview'

export default function CommandCenterPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Command Center</h1>
        <p className="text-sm text-muted-foreground">
          Your prioritized feed of actions, commitments, and briefs.
        </p>
      </div>
      <div className="space-y-8">
        <StatsOverview />
        <DailyView />
      </div>
    </div>
  )
}
