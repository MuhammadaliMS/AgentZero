'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface ValueItem {
  icon: 'email' | 'calendar' | 'compliance' | 'security' | 'message'
  title: string
  description: string
  urgency?: 'high' | 'medium' | 'low'
}

interface ValuePreviewProps {
  integrationName: string
  items: ValueItem[]
  loading?: boolean
}

const ICONS: Record<string, React.ReactNode> = {
  email: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  ),
  calendar: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  compliance: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  security: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  message: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
}

const urgencyColors: Record<string, string> = {
  high: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  medium: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
  low: 'bg-gray-100 text-gray-800 dark:bg-gray-900/50 dark:text-gray-200',
}

export function ValuePreview({ integrationName, items, loading }: ValuePreviewProps) {
  if (loading) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Scanning {integrationName} for items needing your attention...
          </div>
        </CardContent>
      </Card>
    )
  }

  if (items.length === 0) return null

  return (
    <Card className="border-green-200 bg-green-50/30 dark:border-green-800 dark:bg-green-950/10">
      <CardContent className="p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Found from {integrationName}
        </p>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-md bg-background/60 p-2.5"
            >
              <div className="mt-0.5 shrink-0 text-muted-foreground">
                {ICONS[item.icon]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{item.title}</p>
                  {item.urgency && (
                    <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 shrink-0 ${urgencyColors[item.urgency]}`}>
                      {item.urgency}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground line-clamp-1">
                  {item.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
