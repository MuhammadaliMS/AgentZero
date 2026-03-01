'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { format, isPast, isToday } from 'date-fns'

import type { Database } from '@/types/database'

type Commitment = Database['public']['Tables']['commitments']['Row']

interface CommitmentCardProps {
  commitment: Commitment
}

const statusColors: Record<string, string> = {
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  at_risk: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  overdue: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  cancelled: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
}

export function CommitmentCard({ commitment }: CommitmentCardProps) {
  const dueDate = commitment.due_date ? new Date(commitment.due_date) : null
  const isOverdue = dueDate ? isPast(dueDate) && !isToday(dueDate) : false
  const isDueToday = dueDate ? isToday(dueDate) : false

  return (
    <Card className={isOverdue ? 'border-red-200 dark:border-red-800' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-medium">{commitment.title}</CardTitle>
          <Badge
            variant="secondary"
            className={statusColors[commitment.status] || ''}
          >
            {commitment.status.replace('_', ' ')}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {commitment.description && (
          <p className="mb-2 text-sm text-muted-foreground line-clamp-2">
            {commitment.description}
          </p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {dueDate && (
            <span className={isOverdue ? 'text-red-600 font-medium' : isDueToday ? 'text-orange-600 font-medium' : ''}>
              Due: {format(dueDate, 'MMM d, yyyy')}
              {isOverdue && ' (overdue)'}
              {isDueToday && ' (today)'}
            </span>
          )}
          {commitment.priority && (
            <span className="capitalize">{commitment.priority} priority</span>
          )}
        </div>
        {commitment.tags && commitment.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {commitment.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
