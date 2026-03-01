'use client'

import type { StatusPart as StatusPartType } from '@/types/chat'

interface StatusBlockProps {
  part: StatusPartType
}

export function StatusBlock({ part }: StatusBlockProps) {
  if (!part.content) return null

  return (
    <div className="my-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" x2="12" y1="8" y2="12" />
        <line x1="12" x2="12.01" y1="16" y2="16" />
      </svg>
      <span>{part.content}</span>
    </div>
  )
}
