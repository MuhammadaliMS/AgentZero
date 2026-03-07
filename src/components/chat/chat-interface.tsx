'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useChat } from '@/hooks/use-chat'
import { MessageBubble } from './message-bubble'
import { AgenticMessage } from './agentic-message'
import { MessageInput } from './message-input'
import { IntegrationPermissionBar } from './integration-permission-bar'
import { TypingIndicator } from './typing-indicator'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractTextContent } from '@/types/chat'

interface ChatInterfaceProps {
  conversationId?: string
  initialPrompt?: string
}

export function ChatInterface({ conversationId, initialPrompt }: ChatInterfaceProps) {
  const {
    messages,
    sendMessage,
    isStreaming,
    stopStreaming,
    error,
    loadConversation,
    setMessages,
    respondToApproval,
    pendingIntegrations,
    connectIntegration,
    dismissIntegration,
  } = useChat(conversationId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const initialPromptSent = useRef(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isNearBottom, setIsNearBottom] = useState(true)

  // Scroll-to-bottom detection
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const nearBottom = distanceFromBottom < 100
    setIsNearBottom(nearBottom)
    setShowScrollButton(!nearBottom && messages.length > 3)
  }, [messages.length])

  // Attach scroll listener
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Auto-scroll to bottom when near bottom or when new messages arrive
  useEffect(() => {
    if (scrollRef.current && isNearBottom) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isStreaming, isNearBottom])

  // Load existing conversation
  useEffect(() => {
    if (conversationId) {
      loadConversation(conversationId)
    }
  }, [conversationId, loadConversation])

  // Auto-send initial prompt from command palette quick actions
  useEffect(() => {
    if (initialPrompt && !initialPromptSent.current && !conversationId && messages.length === 0) {
      initialPromptSent.current = true
      const timer = setTimeout(() => {
        sendMessage(initialPrompt)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [initialPrompt, conversationId, messages.length, sendMessage])

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }

  // Retry: remove the last assistant message and last user message, then re-send
  const handleRetry = useCallback((content: string) => {
    if (isStreaming) return
    setMessages(prev => {
      const newMessages = [...prev]
      // Pop assistant message
      if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'assistant') {
        newMessages.pop()
      }
      // Pop user message
      if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'user') {
        newMessages.pop()
      }
      return newMessages
    })
    // Re-send after state update
    setTimeout(() => sendMessage(content), 50)
  }, [isStreaming, sendMessage, setMessages])

  // Find the last user message index for retry button
  const lastUserMessageIndex = messages.reduce((acc, msg, idx) =>
    msg.role === 'user' ? idx : acc, -1
  )

  // Check if the last message is a streaming assistant with no parts yet
  const lastMessage = messages[messages.length - 1]
  const showTypingIndicator = isStreaming && lastMessage?.role === 'assistant' && lastMessage.parts.length === 0

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="mx-auto max-w-3xl px-4 pb-8">
          {/* Empty state */}
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold">Captain</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Your strategic AI aide. Ask about your deliverables, platform health,
                pending commitments, or anything else on your plate.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "What's on my plate today?",
                  'Show my delivery status',
                  'Any commitments at risk?',
                  'Prep me for my next meeting',
                ].map((label) => (
                  <button
                    key={label}
                    onClick={() => sendMessage(label)}
                    className="rounded-full border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((message, index) => {
            if (message.role === 'user' || message.role === 'system') {
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRetry={handleRetry}
                  isLastUserMessage={index === lastUserMessageIndex}
                />
              )
            }

            // Assistant messages — agentic rendering with inline parts
            return (
              <AgenticMessage
                key={message.id}
                message={message}
                isStreaming={isStreaming && index === messages.length - 1}
                onApproval={respondToApproval}
              />
            )
          })}

          {/* Typing indicator — only when assistant message has no parts yet */}
          {showTypingIndicator && (
            <TypingIndicator />
          )}

          {/* Error display */}
          {error && (
            <div className="mx-auto my-4 max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-center text-sm text-destructive">
              <p>{error}</p>
              {messages.length > 0 && (
                <button
                  onClick={() => {
                    const lastUserMsg = messages.filter(m => m.role === 'user').pop()
                    if (lastUserMsg) {
                      const text = extractTextContent(lastUserMsg.parts)
                      if (text) handleRetry(text)
                    }
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-2 hover:no-underline"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Scroll to bottom button */}
      <div className={cn(
        'absolute bottom-20 left-1/2 -translate-x-1/2 transition-all duration-200',
        showScrollButton ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}>
        <Button
          variant="outline"
          size="sm"
          onClick={scrollToBottom}
          className="rounded-full shadow-md gap-1 h-8 text-xs"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Scroll to bottom
        </Button>
      </div>

      {/* Integration permission bars — appear above input when agent is blocked */}
      {pendingIntegrations.map((integration) => (
        <IntegrationPermissionBar
          key={integration.approvalId}
          integration={integration}
          onConnect={(approvalId) => {
            connectIntegration(approvalId)
          }}
          onDismiss={(approvalId) => {
            dismissIntegration(approvalId)
          }}
        />
      ))}

      <MessageInput
        onSend={sendMessage}
        isStreaming={isStreaming || pendingIntegrations.length > 0}
        onStop={stopStreaming}
      />
    </div>
  )
}
