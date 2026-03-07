'use client'

import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgenticMessage } from '@/types/chat'
import { extractTextContent } from '@/types/chat'
import { Check, Copy, RotateCcw, User } from 'lucide-react'

interface MessageBubbleProps {
  message: AgenticMessage
  onRetry?: (content: string) => void
  isLastUserMessage?: boolean
}

/**
 * MessageBubble — renders user messages only.
 * Assistant messages are rendered by AgenticMessage component.
 */
export function MessageBubble({ message, onRetry, isLastUserMessage }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false)

  // Extract text content from parts
  const textContent = extractTextContent(message.parts)

  const handleCopy = useCallback(async () => {
    if (!textContent) return
    try {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = textContent
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [textContent])

  // System messages
  if (message.role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <span className="text-xs text-muted-foreground italic">{textContent}</span>
      </div>
    )
  }

  const formattedTime = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(message.createdAt)

  return (
    <div className={cn('group flex gap-3 py-3 justify-end animate-slide-up')}>
      <div className="flex flex-col gap-1 max-w-[80%]">
        <div className="rounded-2xl px-4 py-3 bg-primary text-primary-foreground shadow-sm">
          <p className="whitespace-pre-wrap text-sm">{textContent}</p>
        </div>

        {/* Action bar — shows on hover */}
        <div className={cn(
          'flex items-center gap-1 transition-opacity justify-end',
          'opacity-0 group-hover:opacity-100'
        )}>
          <span className="text-[10px] text-muted-foreground mr-1">
            {formattedTime}
          </span>

          {/* Copy button */}
          {textContent.length > 0 && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleCopy}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">{copied ? 'Copied!' : 'Copy'}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Retry button — only on the last user message */}
          {isLastUserMessage && onRetry && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onRetry(textContent)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Retry</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* User avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <User className="h-4 w-4" />
      </div>
    </div>
  )
}
