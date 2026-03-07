'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Mail, Calendar, Shield, AlertCircle, MessageSquare, Loader2 } from 'lucide-react'

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
  email: <Mail className="h-4 w-4" />,
  calendar: <Calendar className="h-4 w-4" />,
  compliance: <Shield className="h-4 w-4" />,
  security: <AlertCircle className="h-4 w-4" />,
  message: <MessageSquare className="h-4 w-4" />,
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
            <Loader2 className="h-4 w-4 animate-spin" />
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
