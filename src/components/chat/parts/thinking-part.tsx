'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ThinkingPart as ThinkingPartType } from '@/types/chat'

interface ThinkingPartProps {
  part: ThinkingPartType
}

export function ThinkingPartBlock({ part }: ThinkingPartProps) {
  const [expanded, setExpanded] = useState(false)

  // Summarize: first ~60 chars or "Thinking..."
  const summary = part.content
    ? part.content.slice(0, 60) + (part.content.length > 60 ? '...' : '')
    : 'Thinking...'

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
          'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
          part.isStreaming && 'animate-pulse'
        )}
      >
        {/* Brain icon */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z" />
          <path d="M12 2v4" />
          <path d="M8 6l2 2" />
          <path d="M16 6l-2 2" />
        </svg>
        <span className="truncate max-w-[300px]">
          {expanded ? 'Thinking' : summary}
        </span>
        {/* Chevron */}
        <svg
          width="10"
          height="10"
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
        <div className="mt-2 ml-1 rounded-lg border bg-muted/30 p-3">
          <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed">
            {part.content}
          </pre>
        </div>
      )}
    </div>
  )
}
