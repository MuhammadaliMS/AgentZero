'use client'

import { LayoutGrid, Sparkles } from 'lucide-react'
import { DailyView } from '@/components/command-center/daily-view'
import { StatsOverview } from '@/components/command-center/stats-overview'
import { AIActivityView } from '@/components/command-center/ai-activity-view'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

export default function CommandCenterPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
      {/* Header */}
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center justify-between">
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
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary ring-1 ring-primary/10">
            <Sparkles className="h-3.5 w-3.5" />
            Live
          </div>
        </div>
      </header>

      {/* Tabs: Feed | AI Activity */}
      <Tabs defaultValue="feed">
        <TabsList variant="line" className="mb-6">
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="ai-activity">AI Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="feed">
          <div className="space-y-8">
            <StatsOverview />
            <div className="border-t border-border/40 pt-8">
              <DailyView />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="ai-activity">
          <AIActivityView />
        </TabsContent>
      </Tabs>
    </div>
  )
}
