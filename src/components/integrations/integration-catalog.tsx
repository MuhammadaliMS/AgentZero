'use client'

import { IntegrationCard } from './integration-card'
import type { IntegrationWithStatus } from '@/types/integrations'

const CATEGORY_ORDER = [
  'email',
  'messenger',
  'calendar',
  'risk_and_compliance',
  'endpoint_detection',
  'vulnerability_management',
  'developer_tools',
  'content_management',
  'meeting_intelligence',
]

const CATEGORY_DISPLAY: Record<string, string> = {
  email: 'Email',
  messenger: 'Messaging',
  calendar: 'Calendar',
  risk_and_compliance: 'Security & Compliance',
  endpoint_detection: 'Security & Compliance',
  vulnerability_management: 'Security & Compliance',
  developer_tools: 'Developer Tools',
  content_management: 'Content & Knowledge',
  meeting_intelligence: 'Meeting Intelligence',
}

export function IntegrationCatalog({
  integrations,
  loading,
  onConnected,
  showManagement = false,
}: {
  integrations: IntegrationWithStatus[]
  loading: boolean
  onConnected?: () => void
  showManagement?: boolean
}) {
  if (loading) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
              <div className="h-3 w-8 animate-pulse rounded bg-muted/40" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, j) => (
                <div key={j} className="h-[72px] animate-pulse rounded-xl bg-muted/40" />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Group by display category (merge security categories)
  const grouped = new Map<string, IntegrationWithStatus[]>()
  for (const integration of integrations) {
    const displayCat = CATEGORY_DISPLAY[integration.category] || integration.category
    const existing = grouped.get(displayCat) || []
    existing.push(integration)
    grouped.set(displayCat, existing)
  }

  // Sort groups by category order
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const aIdx = CATEGORY_ORDER.findIndex(c => CATEGORY_DISPLAY[c] === a[0])
    const bIdx = CATEGORY_ORDER.findIndex(c => CATEGORY_DISPLAY[c] === b[0])
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
  })

  return (
    <div className="space-y-6">
      {sortedGroups.map(([category, items]) => {
        const connectedCount = items.filter(i => i.connected).length
        return (
          <div key={category}>
            {/* Category header */}
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {category}
                </h3>
                <span className="text-[10px] text-muted-foreground/50">
                  {connectedCount}/{items.length}
                </span>
              </div>
              {/* Progress bar */}
              <div className="hidden sm:flex items-center gap-2">
                <div className="h-1 w-16 rounded-full bg-muted/60 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all duration-500"
                    style={{ width: `${items.length > 0 ? (connectedCount / items.length) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Cards */}
            <div className="space-y-2">
              {items.map(integration => (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  onConnected={onConnected}
                  showManagement={showManagement}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
