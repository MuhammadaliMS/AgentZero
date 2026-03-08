'use client'

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SDKToggle } from '@/components/sdk-toggle'
import { Send, Square } from 'lucide-react'

interface MessageInputProps {
  onSend: (message: string) => void
  isStreaming: boolean
  onStop?: () => void
  placeholder?: string
}

export function MessageInput({ onSend, isStreaming, onStop, placeholder }: MessageInputProps) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [charCount, setCharCount] = useState(0)

  // Auto-focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setInput('')
    setCharCount(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [input, isStreaming, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    setCharCount(value.length)
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }

  return (
    <div className="shrink-0 border-t border-border/40 bg-background/80 backdrop-blur-sm px-4 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {/* Input row */}
        <div className="relative flex items-end gap-2">
          <div className="relative flex-1">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || 'Message your Captain...'}
              className="min-h-[48px] max-h-[200px] resize-none rounded-xl border-border/50 bg-muted/20 pr-4 shadow-sm transition-all duration-200 focus:shadow-md focus:border-primary/30 focus:ring-1 focus:ring-primary/20"
              rows={1}
              disabled={isStreaming}
            />
          </div>

          {isStreaming ? (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={onStop}
                    className="shrink-0 h-10 w-10 rounded-xl border-border/60 cursor-pointer hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive transition-colors"
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Stop generating</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={!input.trim()}
                    className="shrink-0 h-10 w-10 rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all duration-200 hover:shadow-md hover:shadow-primary/25 active:scale-95 disabled:opacity-30 disabled:shadow-none disabled:hover:shadow-none cursor-pointer"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Send message (Enter)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Footer */}
        <div className="mt-1.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-2.5">
            <SDKToggle variant="compact" />
            <span className="text-[10px] text-muted-foreground/50">
              Shift+Enter for new line
            </span>
          </div>
          {charCount > 500 && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums">
              {charCount.toLocaleString()} chars
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
