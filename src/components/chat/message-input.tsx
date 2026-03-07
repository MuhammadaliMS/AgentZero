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
    // Reset textarea height
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
    // Auto-resize
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }

  return (
    <div className="shrink-0 border-t glass px-4 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          <div className="relative flex-1">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || 'Message your Captain...'}
              className="min-h-[44px] max-h-[200px] resize-none pr-10 rounded-xl bg-muted/30 shadow-sm focus:shadow-md transition-shadow"
              rows={1}
              disabled={isStreaming}
            />
          </div>
          {isStreaming ? (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={onStop} className="shrink-0 h-10 w-10 rounded-xl">
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
                    className="shrink-0 h-10 w-10 rounded-xl bg-gradient-brand hover:opacity-90 transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                  >
                    <Send className="h-4 w-4 text-white" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Send message (Enter)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {/* Footer hint + SDK toggle */}
        <div className="mt-1.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <SDKToggle variant="compact" />
            <span className="text-[10px] text-muted-foreground/60">
              Shift+Enter for new line
            </span>
          </div>
          {charCount > 500 && (
            <span className="text-[10px] text-muted-foreground/60">
              {charCount.toLocaleString()} chars
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
