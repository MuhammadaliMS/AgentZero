'use client'

import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, Clock, ArrowRight } from 'lucide-react'
import type { Database } from '@/types/database'

type Action = Database['public']['Tables']['actions']['Row']

interface ActionCardProps {
  action: Action
  onResolve: (actionId: string, resolution: 'approved' | 'rejected' | 'deferred') => void
}

const priorityConfig: Record<string, { dot: string; label: string; bg: string }> = {
  critical: { dot: 'bg-red-500', label: 'Critical', bg: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400' },
  high: { dot: 'bg-amber-500', label: 'High', bg: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400' },
  medium: { dot: 'bg-blue-500', label: 'Medium', bg: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400' },
  low: { dot: 'bg-slate-400', label: 'Low', bg: 'bg-muted text-muted-foreground' },
}

export function ActionCard({ action, onResolve }: ActionCardProps) {
  const priority = priorityConfig[action.priority || 'medium'] || priorityConfig.medium

  return (
    <div className="group rounded-xl border border-border/50 bg-card p-4 transition-all duration-200 hover:shadow-md hover:border-border">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium leading-snug">{action.title}</h3>
        {action.priority && (
          <span className={`inline-flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${priority.bg}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${priority.dot}`} />
            {priority.label}
          </span>
        )}
      </div>

      {action.description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 mb-3">
          {action.description}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={() => onResolve(action.id, 'approved')}
          className="h-7 gap-1 px-2.5 text-xs cursor-pointer"
        >
          <CheckCircle2 className="h-3 w-3" />
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve(action.id, 'rejected')}
          className="h-7 gap-1 px-2.5 text-xs text-destructive hover:text-destructive cursor-pointer"
        >
          <XCircle className="h-3 w-3" />
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onResolve(action.id, 'deferred')}
          className="h-7 gap-1 px-2.5 text-xs text-muted-foreground cursor-pointer"
        >
          <Clock className="h-3 w-3" />
          Defer
        </Button>
      </div>
    </div>
  )
}
