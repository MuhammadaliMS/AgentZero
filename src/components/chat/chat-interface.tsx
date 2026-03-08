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
import { Sparkles, CalendarCheck, BarChart3, AlertTriangle, Presentation, ChevronDown, RotateCcw } from 'lucide-react'

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
      if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'assistant') {
        newMessages.pop()
      }
      if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'user') {
        newMessages.pop()
      }
      return newMessages
    })
    setTimeout(() => sendMessage(content), 50)
  }, [isStreaming, sendMessage, setMessages])

  // Find the last user message index for retry button
  const lastUserMessageIndex = messages.reduce((acc, msg, idx) =>
    msg.role === 'user' ? idx : acc, -1
  )

  // Check if the last message is a streaming assistant with no parts yet
  const lastMessage = messages[messages.length - 1]
  const showTypingIndicator = isStreaming && lastMessage?.role === 'assistant' && lastMessage.parts.length === 0

  const quickActions = [
    { label: "What's on my plate today?", icon: CalendarCheck },
    { label: 'Show my delivery status', icon: BarChart3 },
    { label: 'Any commitments at risk?', icon: AlertTriangle },
    { label: 'Prep me for my next meeting', icon: Presentation },
  ]

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Message area */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="mx-auto max-w-3xl px-4 pb-8">
          {/* Empty state */}
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
              {/* Logo */}
              <div className="relative mb-6">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 animate-float">
                  <Sparkles className="h-8 w-8" />
                </div>
                <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-emerald-500 ring-2 ring-background" />
              </div>

              {/* Title */}
              <h2 className="text-2xl font-bold tracking-tight">Captain</h2>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Your strategic AI aide. Ask about deliverables, platform health,
                commitments, or anything on your plate.
              </p>

              {/* Quick actions */}
              <div className="mt-10 grid grid-cols-2 gap-2.5 max-w-lg w-full">
                {quickActions.map(({ label, icon: Icon }) => (
                  <button
                    key={label}
                    onClick={() => sendMessage(label)}
                    className="group flex items-center gap-2.5 rounded-xl border border-border/50 bg-card px-3.5 py-3 text-left text-[13px] text-muted-foreground transition-all duration-200 hover:shadow-md hover:border-primary/20 hover:text-foreground hover:bg-primary/[0.02] cursor-pointer"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 transition-colors group-hover:bg-primary/15">
                      <Icon className="h-4 w-4 text-primary/60 group-hover:text-primary transition-colors" />
                    </div>
                    <span className="leading-snug">{label}</span>
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

            return (
              <AgenticMessage
                key={message.id}
                message={message}
                isStreaming={isStreaming && index === messages.length - 1}
                onApproval={respondToApproval}
              />
            )
          })}

          {/* Typing indicator */}
          {showTypingIndicator && <TypingIndicator />}

          {/* Error display */}
          {error && (
            <div className="mx-auto my-4 max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center text-sm text-destructive">
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
                  className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 hover:no-underline cursor-pointer transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Scroll to bottom */}
      <div className={cn(
        'absolute bottom-20 left-1/2 -translate-x-1/2 transition-all duration-200',
        showScrollButton ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}>
        <Button
          variant="outline"
          size="sm"
          onClick={scrollToBottom}
          className="rounded-full shadow-lg gap-1.5 h-8 text-xs border-border/60 bg-background/90 backdrop-blur-sm hover:bg-background cursor-pointer"
        >
          <ChevronDown className="h-3 w-3" />
          Scroll to bottom
        </Button>
      </div>

      {/* Integration permission bars */}
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

      {/* Input */}
      <MessageInput
        onSend={sendMessage}
        isStreaming={isStreaming || pendingIntegrations.length > 0}
        onStop={stopStreaming}
      />
    </div>
  )
}
