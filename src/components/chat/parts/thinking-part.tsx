'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Brain, ChevronDown } from 'lucide-react'
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
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer',
          'text-muted-foreground/70 hover:bg-accent hover:text-foreground',
          part.isStreaming && 'animate-pulse'
        )}
      >
        <Brain className="h-3 w-3 shrink-0" />
        <span className="truncate max-w-[300px] italic">
          {expanded ? 'Thinking' : summary}
        </span>
        <ChevronDown
          className={cn(
            'h-2.5 w-2.5 transition-transform shrink-0',
            expanded ? 'rotate-180' : ''
          )}
        />
      </button>

      {expanded && part.content && (
        <div className="mt-1 ml-1 rounded-md border border-border bg-accent/30 p-3">
          <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed">
            {part.content}
          </pre>
        </div>
      )}
    </div>
  )
}
