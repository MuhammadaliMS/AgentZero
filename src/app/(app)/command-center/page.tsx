'use client'

import { LayoutGrid } from 'lucide-react'
import { DailyView } from '@/components/command-center/daily-view'
import { StatsOverview } from '@/components/command-center/stats-overview'

export default function CommandCenterPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <LayoutGrid className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
            <p className="text-[13px] text-muted-foreground leading-none mt-0.5">
              Your prioritized feed of actions, commitments &amp; briefs
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-8">
        <StatsOverview />
        <DailyView />
      </div>
    </div>
  )
}
