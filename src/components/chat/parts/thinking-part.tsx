'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ThinkingPart as ThinkingPartType } from '@/types/chat'

interface ThinkingPartProps {
  part: ThinkingPartType
}

export function ThinkingPartBlock({ part }: ThinkingPartProps) {
  const [expanded, setExpanded] = useState(false)

  // Don't render empty thinking blocks
  if (!part.content && !part.isStreaming) return null

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] transition-colors',
          'text-muted-foreground/50 hover:text-muted-foreground/80 hover:bg-muted/40',
          part.isStreaming && 'animate-pulse text-muted-foreground/70'
        )}
      >
        {/* Small sparkle/thought icon */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 opacity-60"
        >
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
        <span>{part.isStreaming ? 'Reasoning…' : 'Reasoned'}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn(
            'transition-transform shrink-0',
            expanded ? 'rotate-180' : ''
          )}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && part.content && (
        <div className="mt-1 ml-1 rounded border border-border/40 bg-muted/20 p-2">
          <pre className="whitespace-pre-wrap text-[10px] text-muted-foreground/60 font-mono leading-relaxed">
            {part.content}
          </pre>
        </div>
      )}
    </div>
  )
}
