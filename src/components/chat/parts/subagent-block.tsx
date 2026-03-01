'use client'

import { cn } from '@/lib/utils'
import type { SubagentPart as SubagentPartType } from '@/types/chat'

interface SubagentBlockProps {
  part: SubagentPartType
}

export function SubagentBlock({ part }: SubagentBlockProps) {
  const isRunning = part.status === 'running'

  return (
    <div className="my-1">
      <div
        className={cn(
          'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors',
          'border bg-violet-500/5 border-violet-500/20 text-muted-foreground',
          isRunning && 'animate-pulse'
        )}
      >
        {/* Specialist / Users icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-violet-500"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>

        <span className="font-medium">
          {isRunning
            ? `Consulting ${part.displayName}...`
            : `Consulted ${part.displayName}`}
        </span>

        {/* Status indicator */}
        {isRunning ? (
          <svg className="h-3.5 w-3.5 animate-spin text-violet-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>

      {/* Summary (shown when completed and summary exists) */}
      {!isRunning && part.summary && (
        <div className="mt-1.5 ml-1 rounded-lg border border-violet-500/10 bg-violet-500/5 p-2.5">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {part.summary}
          </p>
        </div>
      )}
    </div>
  )
}
