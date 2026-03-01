'use client'

import { useState, useCallback, useRef } from 'react'
import type {
  AgenticMessage,
  MessagePart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  ApprovalRequestPart,
  SubagentPart,
} from '@/types/chat'
import { generatePartId, getSubagentDisplayName } from '@/types/chat'

// ─── Stream Event (matches server-side StreamEvent) ─────────────────────

interface StreamEvent {
  type: string
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolDisplayName?: string
  agentId?: string
  conversationId?: string
  approvalId?: string
  approvalTitle?: string
  approvalDescription?: string
  approvalDecision?: string
  integrationKey?: string
  integrationName?: string
  decision?: string
  usage?: { input_tokens: number; output_tokens: number }
  costUsd?: number
  durationMs?: number
}

// ─── Tool Display Name Fallback ─────────────────────────────────────────

function formatToolName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Process SSE Event Into Parts ───────────────────────────────────────

function processEvent(
  event: StreamEvent,
  parts: MessagePart[]
): void {
  switch (event.type) {
    case 'text': {
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.type === 'text') {
        ;(lastPart as TextPart).content += event.content || ''
      } else {
        parts.push({
          id: generatePartId(),
          type: 'text',
          content: event.content || '',
          timestamp: Date.now(),
        } as TextPart)
      }
      break
    }

    case 'thinking': {
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.type === 'thinking' && (lastPart as ThinkingPart).isStreaming) {
        ;(lastPart as ThinkingPart).content += event.content || ''
      } else {
        parts.push({
          id: generatePartId(),
          type: 'thinking',
          content: event.content || '',
          isStreaming: true,
          timestamp: Date.now(),
        } as ThinkingPart)
      }
      break
    }

    case 'tool_use': {
      // Close any streaming thinking part
      const lastThinking = [...parts].reverse().find(
        (p) => p.type === 'thinking' && (p as ThinkingPart).isStreaming
      )
      if (lastThinking) {
        ;(lastThinking as ThinkingPart).isStreaming = false
      }

      parts.push({
        id: generatePartId(),
        type: 'tool_call',
        toolName: event.toolName || '',
        toolInput: event.toolInput || {},
        displayName: event.toolDisplayName || formatToolName(event.toolName || ''),
        status: 'running',
        timestamp: Date.now(),
      } as ToolCallPart)
      break
    }

    case 'tool_result': {
      const lastToolCall = [...parts].reverse().find(
        (p) => p.type === 'tool_call' && (p as ToolCallPart).status === 'running'
      ) as ToolCallPart | undefined

      const resultPart: ToolResultPart = {
        id: generatePartId(),
        type: 'tool_result',
        toolName: event.toolName || '',
        content: event.content || '',
        success: event.content !== 'failed',
        toolCallPartId: lastToolCall?.id || '',
        timestamp: Date.now(),
      }
      parts.push(resultPart)

      if (lastToolCall) {
        lastToolCall.status = event.content === 'failed' ? 'failed' : 'completed'
        if (event.durationMs) lastToolCall.durationMs = event.durationMs
        lastToolCall.resultPartId = resultPart.id
      }
      break
    }

    case 'approval_required': {
      parts.push({
        id: generatePartId(),
        type: 'approval_request',
        approvalId: event.approvalId || '',
        toolName: event.toolName || '',
        toolInput: event.toolInput || {},
        title: event.approvalTitle || `Approve: ${event.toolName}`,
        description: event.approvalDescription || '',
        status: 'pending',
        timestamp: Date.now(),
      } as ApprovalRequestPart)
      break
    }

    case 'approval_resolved': {
      const approvalPart = parts.find(
        (p) =>
          p.type === 'approval_request' &&
          (p as ApprovalRequestPart).approvalId === event.approvalId
      ) as ApprovalRequestPart | undefined

      if (approvalPart) {
        approvalPart.status =
          event.approvalDecision === 'approved' ? 'approved' : 'rejected'
      }
      break
    }

    case 'integration_required':
    case 'integration_resolved':
      // No inline parts — integration events are handled entirely
      // by the permission bar at the bottom of the chat (see main SSE loop).
      break

    case 'subagent_start': {
      parts.push({
        id: generatePartId(),
        type: 'subagent',
        agentId: event.agentId || '',
        displayName: getSubagentDisplayName(event.agentId || ''),
        status: 'running',
        timestamp: Date.now(),
      } as SubagentPart)
      break
    }

    case 'subagent_stop': {
      const subagentPart = [...parts].reverse().find(
        (p) =>
          p.type === 'subagent' &&
          (p as SubagentPart).agentId === event.agentId
      ) as SubagentPart | undefined

      if (subagentPart) {
        subagentPart.status = 'completed'
        if (event.content) subagentPart.summary = event.content
      }
      break
    }

    case 'status':
    case 'task_started':
    case 'task_progress':
    case 'task_completed': {
      if (event.content) {
        parts.push({
          id: generatePartId(),
          type: 'status',
          content: event.content,
          timestamp: Date.now(),
        })
      }
      break
    }

    // 'done', 'error', 'prompt_suggestion' handled separately in the main loop
  }
}

// ─── useChat Hook ───────────────────────────────────────────────────────

export function useChat(initialConversationId?: string) {
  const [messages, setMessages] = useState<AgenticMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  // Mutable ref for current assistant message's parts (avoids re-render per chunk)
  const currentPartsRef = useRef<MessagePart[]>([])

  // ─── Integration Permission Bar State ────────────────────────────────
  // When the agent is blocked waiting for integration connections,
  // this state drives the permission bars above the chat input.
  // Supports multiple concurrent integrations (e.g. Calendar + Gmail).
  const [pendingIntegrations, setPendingIntegrations] = useState<
    Array<{
      approvalId: string
      integrationKey: string
      integrationName: string
      reason: string
    }>
  >([])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isStreaming) return

      setError(null)

      // Add user message
      const userMessage: AgenticMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        parts: [
          {
            id: generatePartId(),
            type: 'text',
            content,
            timestamp: Date.now(),
          } as TextPart,
        ],
        createdAt: new Date(),
      }
      setMessages((prev) => [...prev, userMessage])

      // Add placeholder assistant message
      const assistantId = `assistant-${Date.now()}`
      currentPartsRef.current = []
      const assistantMessage: AgenticMessage = {
        id: assistantId,
        role: 'assistant',
        parts: [],
        createdAt: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
      setIsStreaming(true)

      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: content, conversationId }),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (!data) continue

            try {
              const event: StreamEvent = JSON.parse(data)

              switch (event.type) {
                case 'done':
                  if (event.conversationId) {
                    setConversationId(event.conversationId)
                  }
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantId
                        ? {
                            ...msg,
                            parts: [...currentPartsRef.current],
                            metadata: {
                              usage: event.usage,
                              costUsd: event.costUsd,
                            },
                          }
                        : msg
                    )
                  )
                  break

                case 'error':
                  setError(event.content || 'An error occurred')
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantId
                        ? {
                            ...msg,
                            parts: currentPartsRef.current.length > 0
                              ? [...currentPartsRef.current]
                              : [{
                                  id: generatePartId(),
                                  type: 'text' as const,
                                  content: 'Sorry, I encountered an error. Please try again.',
                                  timestamp: Date.now(),
                                }],
                            metadata: { error: event.content },
                          }
                        : msg
                    )
                  )
                  break

                default:
                  // Process all other events into parts
                  processEvent(event, currentPartsRef.current)

                  // Integration permission bar state management:
                  // Add when agent is blocked waiting for an integration,
                  // remove when the integration is connected or dismissed.
                  if (event.type === 'integration_required' && event.approvalId) {
                    setPendingIntegrations((prev) => {
                      // Avoid duplicates (same integrationKey)
                      if (prev.some((p) => p.integrationKey === event.integrationKey)) return prev
                      return [
                        ...prev,
                        {
                          approvalId: event.approvalId!,
                          integrationKey: event.integrationKey || '',
                          integrationName: event.integrationName || '',
                          reason: event.content || '',
                        },
                      ]
                    })
                  } else if (event.type === 'integration_resolved') {
                    setPendingIntegrations((prev) =>
                      prev.filter((p) => p.integrationKey !== event.integrationKey)
                    )
                  }

                  // Update React state with snapshot of current parts
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantId
                        ? { ...msg, parts: [...currentPartsRef.current] }
                        : msg
                    )
                  )
                  break
              }
            } catch {
              // Skip malformed events
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
        const errorMsg = err instanceof Error ? err.message : 'Failed to send message'
        setError(errorMsg)
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  parts: [{
                    id: generatePartId(),
                    type: 'text' as const,
                    content: 'Sorry, I encountered an error. Please try again.',
                    timestamp: Date.now(),
                  }],
                  metadata: { error: errorMsg },
                }
              : msg
          )
        )
      } finally {
        // Close any streaming thinking parts
        for (const part of currentPartsRef.current) {
          if (part.type === 'thinking' && (part as ThinkingPart).isStreaming) {
            ;(part as ThinkingPart).isStreaming = false
          }
        }
        setIsStreaming(false)
        abortControllerRef.current = null
      }
    },
    [isStreaming, conversationId]
  )

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort()
    setIsStreaming(false)
  }, [])

  // ─── Approval Response ──────────────────────────────────────────────

  const respondToApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'reject') => {
      try {
        const response = await fetch('/api/agent/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId, decision }),
        })

        if (!response.ok) {
          console.error('Failed to submit approval:', await response.text())
        }
      } catch (err) {
        console.error('Error submitting approval:', err)
      }
    },
    []
  )

  // ─── Integration Permission Bar Actions ───────────────────────────
  // Used by the IntegrationPermissionBar component when the user
  // clicks "Connect" (after OAuth) or "Skip".

  const connectIntegration = useCallback(
    async (approvalId: string) => {
      // Reuse the same approval resolve endpoint — 'approve' unblocks canUseTool
      await respondToApproval(approvalId, 'approve')
    },
    [respondToApproval]
  )

  const dismissIntegration = useCallback(
    async (approvalId: string) => {
      await respondToApproval(approvalId, 'reject')
      setPendingIntegrations((prev) => prev.filter((p) => p.approvalId !== approvalId))
    },
    [respondToApproval]
  )

  // ─── Load Conversation ────────────────────────────────────────────

  const loadConversation = useCallback(async (convId: string) => {
    try {
      const response = await fetch(`/api/agent/chat?conversationId=${convId}`)
      if (response.ok) {
        const data = await response.json()
        setMessages(
          data.messages.map(
            (m: {
              id: string
              role: string
              content: string
              parts?: unknown
              created_at: string
              metadata?: Record<string, unknown>
            }) => {
              // Use persisted parts from the DB column; fall back to a single text part
              const savedParts = m.parts as MessagePart[] | undefined
              const parts: MessagePart[] =
                savedParts && Array.isArray(savedParts)
                  ? savedParts
                  : [
                      {
                        id: generatePartId(),
                        type: 'text' as const,
                        content: m.content,
                        timestamp: new Date(m.created_at).getTime(),
                      },
                    ]

              return {
                id: m.id,
                role: m.role as 'user' | 'assistant' | 'system',
                parts,
                createdAt: new Date(m.created_at),
                metadata: m.metadata
                  ? {
                      usage: m.metadata.usage as
                        | { input_tokens: number; output_tokens: number }
                        | undefined,
                      costUsd: m.metadata.cost_usd as number | undefined,
                      error: m.metadata.error as string | undefined,
                    }
                  : undefined,
              } as AgenticMessage
            }
          )
        )
        setConversationId(convId)
      }
    } catch {
      setError('Failed to load conversation')
    }
  }, [])

  return {
    messages,
    sendMessage,
    isStreaming,
    stopStreaming,
    conversationId,
    error,
    loadConversation,
    setMessages,
    respondToApproval,
    pendingIntegrations,
    connectIntegration,
    dismissIntegration,
  }
}
