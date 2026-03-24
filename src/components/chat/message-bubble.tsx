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
      <div className="flex justify-center py-3">
        <span className="text-xs text-muted-foreground/60 italic px-3 py-1 rounded-full bg-muted/30">
          {textContent}
        </span>
      </div>
    )
  }

  const formattedTime = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(message.createdAt)

  return (
    <div className={cn('group flex gap-3 py-4 justify-end animate-fade-in')}>
      <div className="flex flex-col gap-1 max-w-[75%]">
        {/* Message bubble */}
        <div className="rounded-2xl rounded-br-sm px-4 py-2.5 bg-muted/80 text-foreground">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{textContent}</p>
        </div>

        {/* Hover action bar */}
        <div className={cn(
          'flex items-center gap-0.5 transition-all duration-150 justify-end',
          'opacity-0 group-hover:opacity-100'
        )}>
          <span className="text-[10px] text-muted-foreground/50 mr-1 tabular-nums">
            {formattedTime}
          </span>

          {/* Copy */}
          {textContent.length > 0 && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleCopy}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-600" />
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

          {/* Retry */}
          {isLastUserMessage && onRetry && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onRetry(textContent)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
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
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground/60">
        <User className="h-3.5 w-3.5" />
      </div>
    </div>
  )
}
