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
    <div className="shrink-0 border-t border-border/60 bg-background px-4 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {/* Input row */}
        <div className="relative flex items-end gap-2">
          <div className="relative flex-1">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || 'Ask anything...'}
              className="min-h-[44px] max-h-[200px] resize-none rounded-lg border-border bg-background pr-4 text-[14px] transition-colors duration-150 focus:border-foreground/20 focus:ring-0 placeholder:text-muted-foreground/50"
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
                    className="shrink-0 h-9 w-9 rounded-lg border-border cursor-pointer hover:bg-accent transition-colors"
                  >
                    <Square className="h-3.5 w-3.5" />
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
                    className="shrink-0 h-9 w-9 rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors duration-150 active:scale-[0.97] disabled:opacity-20 cursor-pointer"
                  >
                    <Send className="h-3.5 w-3.5" />
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
            <span className="text-[10px] text-muted-foreground/40">
              Shift+Enter for new line
            </span>
          </div>
          {charCount > 500 && (
            <span className="text-[10px] text-muted-foreground/40 tabular-nums">
              {charCount.toLocaleString()} chars
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
