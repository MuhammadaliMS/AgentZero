'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

import type { Database } from '@/types/database'

type Action = Database['public']['Tables']['actions']['Row']

interface ActionCardProps {
  action: Action
  onResolve: (actionId: string, resolution: 'approved' | 'rejected' | 'deferred') => void
}

const priorityColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  low: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
}

export function ActionCard({ action, onResolve }: ActionCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-medium">{action.title}</CardTitle>
          {action.priority && (
            <Badge variant="secondary" className={priorityColors[action.priority] || ''}>
              {action.priority}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {action.description && (
          <p className="mb-3 text-sm text-muted-foreground">{action.description}</p>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onResolve(action.id, 'approved')}>
            Approve
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onResolve(action.id, 'rejected')}>
            Reject
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve(action.id, 'deferred')}>
            Defer
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
