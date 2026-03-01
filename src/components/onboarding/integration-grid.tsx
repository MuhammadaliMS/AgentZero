'use client'

import { IntegrationCard } from '@/components/integrations/integration-card'
import { Skeleton } from '@/components/ui/skeleton'
import type { IntegrationWithStatus } from '@/types/integrations'

const RECOMMENDED_KEYS = ['slack', 'gmail', 'microsoft_365', 'google_calendar', 'vanta']

const CATEGORY_DISPLAY: Record<string, string> = {
  email: 'Email & Calendar',
  messenger: 'Email & Calendar',
  calendar: 'Email & Calendar',
  risk_and_compliance: 'Security & Compliance',
  endpoint_detection: 'Security & Compliance',
  vulnerability_management: 'Security & Compliance',
  developer_tools: 'Productivity',
  content_management: 'Productivity',
  meeting_intelligence: 'Productivity',
}

export function IntegrationGrid({
  integrations,
  loading,
  onConnected,
}: {
  integrations: IntegrationWithStatus[]
  loading: boolean
  onConnected?: () => void
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  const recommended = integrations.filter(i => RECOMMENDED_KEYS.includes(i.key))
  const others = integrations.filter(i => !RECOMMENDED_KEYS.includes(i.key))

  // Group others by display category
  const grouped = new Map<string, IntegrationWithStatus[]>()
  for (const integration of others) {
    const displayCat = CATEGORY_DISPLAY[integration.category] || 'Other'
    const existing = grouped.get(displayCat) || []
    existing.push(integration)
    grouped.set(displayCat, existing)
  }

  return (
    <div className="space-y-6">
      {/* Recommended section */}
      {recommended.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-yellow-500">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recommended
            </h3>
          </div>
          <div className="space-y-2">
            {recommended.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                onConnected={onConnected}
              />
            ))}
          </div>
        </div>
      )}

      {/* Other categories */}
      {[...grouped.entries()].map(([category, items]) => (
        <div key={category}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {category}
          </h3>
          <div className="space-y-2">
            {items.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                onConnected={onConnected}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
