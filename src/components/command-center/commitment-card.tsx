'use client'

import { format, isPast, isToday } from 'date-fns'
import { Calendar, AlertTriangle } from 'lucide-react'
import type { Database } from '@/types/database'

type Commitment = Database['public']['Tables']['commitments']['Row']

interface CommitmentCardProps {
  commitment: Commitment
}

const statusConfig: Record<string, { dot: string; label: string; bg: string }> = {
  active: { dot: 'bg-blue-500', label: 'Active', bg: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400' },
  at_risk: { dot: 'bg-amber-500', label: 'At Risk', bg: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' },
  overdue: { dot: 'bg-red-500', label: 'Overdue', bg: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400' },
  completed: { dot: 'bg-emerald-500', label: 'Completed', bg: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400' },
  cancelled: { dot: 'bg-slate-400', label: 'Cancelled', bg: 'bg-muted text-muted-foreground' },
}

export function CommitmentCard({ commitment }: CommitmentCardProps) {
  const dueDate = commitment.due_date ? new Date(commitment.due_date) : null
  const isOverdue = dueDate ? isPast(dueDate) && !isToday(dueDate) : false
  const isDueToday = dueDate ? isToday(dueDate) : false
  const status = statusConfig[commitment.status] || statusConfig.active

  return (
    <div
      className={`group rounded-xl border bg-card p-4 transition-all duration-200 hover:shadow-md
        ${isOverdue
          ? 'border-red-200 dark:border-red-800/50 ring-1 ring-red-100 dark:ring-red-900/20'
          : 'border-border/50 hover:border-border'
        }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium leading-snug">{commitment.title}</h3>
        <span className={`inline-flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${status.bg}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </div>

      {commitment.description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 mb-3">
          {commitment.description}
        </p>
      )}

      <div className="flex items-center gap-3 text-xs">
        {dueDate && (
          <span className={`inline-flex items-center gap-1.5 ${
            isOverdue
              ? 'text-red-600 dark:text-red-400 font-medium'
              : isDueToday
              ? 'text-amber-600 dark:text-amber-400 font-medium'
              : 'text-muted-foreground'
          }`}>
            {isOverdue ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <Calendar className="h-3 w-3" />
            )}
            {format(dueDate, 'MMM d, yyyy')}
            {isOverdue && ' (overdue)'}
            {isDueToday && ' (today)'}
          </span>
        )}
        {commitment.priority && (
          <span className="text-muted-foreground capitalize">{commitment.priority}</span>
        )}
      </div>

      {commitment.tags && commitment.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {commitment.tags.map((tag) => (
            <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
