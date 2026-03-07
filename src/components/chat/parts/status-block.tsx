'use client'

import { Info } from 'lucide-react'
import type { StatusPart as StatusPartType } from '@/types/chat'

interface StatusBlockProps {
  part: StatusPartType
}

export function StatusBlock({ part }: StatusBlockProps) {
  if (!part.content) return null

  return (
    <div className="my-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
      <Info className="h-2.5 w-2.5 shrink-0" />
      <span>{part.content}</span>
    </div>
  )
}
