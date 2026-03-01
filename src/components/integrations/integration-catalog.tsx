'use client'

import { IntegrationCard } from './integration-card'
import { Skeleton } from '@/components/ui/skeleton'
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
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
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
      {sortedGroups.map(([category, items]) => (
        <div key={category}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {category}
            </h3>
            <span className="text-[10px] text-muted-foreground/60">
              {items.filter(i => i.connected).length}/{items.length}
            </span>
          </div>
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
      ))}
    </div>
  )
}
