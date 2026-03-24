'use client'

import { cn } from '@/lib/utils'
import { Bot, Check, Loader2 } from 'lucide-react'
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
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
          'text-muted-foreground',
          isRunning && 'animate-pulse'
        )}
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />

        <span className="font-medium">
          {isRunning
            ? `Consulting ${part.displayName}...`
            : `Consulted ${part.displayName}`}
        </span>

        {/* Status indicator */}
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        )}
      </div>

      {/* Summary (shown when completed and summary exists) */}
      {!isRunning && part.summary && (
        <div className="mt-1 ml-1 rounded-md border border-border bg-accent/30 p-2.5">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {part.summary}
          </p>
        </div>
      )}
    </div>
  )
}
