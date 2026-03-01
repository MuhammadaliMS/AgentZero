'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TextPart as TextPartType } from '@/types/chat'

interface TextPartProps {
  part: TextPartType
  isStreaming?: boolean
}

export function TextPartBlock({ part, isStreaming }: TextPartProps) {
  if (!part.content && !isStreaming) return null

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {part.content || ''}
      </ReactMarkdown>
      {isStreaming && !part.content && (
        <span className="inline-block h-4 w-1 animate-pulse bg-foreground/50" />
      )}
    </div>
  )
}
