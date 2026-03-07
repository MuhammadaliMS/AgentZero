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
          'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors',
          'border bg-violet-500/5 border-violet-500/20 text-muted-foreground',
          isRunning && 'animate-pulse'
        )}
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />

        <span className="font-medium">
          {isRunning
            ? `Consulting ${part.displayName}...`
            : `Consulted ${part.displayName}`}
        </span>

        {/* Status indicator */}
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
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
