'use client'

import { useState, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  AgenticMessage as AgenticMessageType,
  MessagePart,
  ToolCallPart,
  ToolResultPart,
} from '@/types/chat'
import { extractTextContent } from '@/types/chat'
import { Bot, Check, Copy } from 'lucide-react'

// Part components
import { TextPartBlock } from './parts/text-part'
import { ThinkingPartBlock } from './parts/thinking-part'
import { ToolCallBlock } from './parts/tool-call-block'
import { ApprovalCard } from './parts/approval-card'
import { SubagentBlock } from './parts/subagent-block'
import { StatusBlock } from './parts/status-block'

// ─── Props ──────────────────────────────────────────────────────────────

interface AgenticMessageProps {
  message: AgenticMessageType
  isStreaming?: boolean
  onApproval: (approvalId: string, decision: 'approve' | 'reject') => void
}

// ─── Part Renderer ──────────────────────────────────────────────────────

function MessagePartRenderer({
  part,
  isStreaming,
  resultPartMap,
  onApproval,
}: {
  part: MessagePart
  isStreaming: boolean
  resultPartMap: Map<string, ToolResultPart>
  onApproval: (approvalId: string, decision: 'approve' | 'reject') => void
}) {
  switch (part.type) {
    case 'text':
      return <TextPartBlock part={part} isStreaming={isStreaming} />

    case 'thinking':
      return <ThinkingPartBlock part={part} />

    case 'tool_call': {
      const toolPart = part as ToolCallPart
      const resultPart = toolPart.resultPartId
        ? resultPartMap.get(toolPart.resultPartId)
        : undefined
      return <ToolCallBlock part={toolPart} resultPart={resultPart} />
    }

    case 'tool_result':
      // Tool results are rendered inline with their tool call block
      // Skip standalone rendering
      return null

    case 'approval_request':
      return <ApprovalCard part={part} onApproval={onApproval} />

    case 'approval_response':
      // Responses are reflected in the approval_request status
      return null

    case 'integration_prompt':
      // Integration prompts are now handled by the permission bar at the
      // bottom of the chat. This case handles old conversation data.
      return null

    case 'subagent':
      return <SubagentBlock part={part} />

    case 'status':
      return <StatusBlock part={part} />

    default:
      return null
  }
}

// ─── Agentic Message Component ──────────────────────────────────────────

export function AgenticMessage({
  message,
  isStreaming = false,
  onApproval,
}: AgenticMessageProps) {
  const [copied, setCopied] = useState(false)

  // Build a map of resultPartId → ToolResultPart for linking
  const resultPartMap = useMemo(() => {
    const map = new Map<string, ToolResultPart>()
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        map.set(part.id, part as ToolResultPart)
      }
    }
    return map
  }, [message.parts])

  // Copy all text content
  const handleCopy = useCallback(async () => {
    const text = extractTextContent(message.parts)
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [message.parts])

  const formattedTime = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(message.createdAt)

  const hasTextContent = message.parts.some(
    (p) => p.type === 'text' && (p as { content?: string }).content
  )

  const hasError = !!message.metadata?.error

  return (
    <div className="group flex gap-3 py-3 animate-fade-in">
      {/* Avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
        <Bot className="h-4 w-4" />
      </div>

      {/* Content */}
      <div className={cn('flex flex-col gap-1 min-w-0 max-w-[85%]', hasError && 'border-l-2 border-destructive/30 pl-3')}>
        {/* Parts */}
        {message.parts.map((part) => (
          <MessagePartRenderer
            key={part.id}
            part={part}
            isStreaming={isStreaming}
            resultPartMap={resultPartMap}
            onApproval={onApproval}
          />
        ))}

        {/* Empty state — show typing cursor if streaming with no parts yet */}
        {isStreaming && message.parts.length === 0 && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="inline-block h-4 w-1 animate-pulse bg-foreground/50 rounded-full" />
          </div>
        )}

        {/* Action bar — shows on hover */}
        <div
          className={cn(
            'flex items-center gap-1 transition-opacity mt-0.5',
            'opacity-0 group-hover:opacity-100'
          )}
        >
          {/* Timestamp */}
          <span className="text-[10px] text-muted-foreground mr-1">
            {formattedTime}
          </span>

          {/* Copy button */}
          {hasTextContent && (
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

          {/* Cost indicator */}
          {typeof message.metadata?.costUsd === 'number' && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-1 text-[10px] text-muted-foreground/60 cursor-help">
                    ${message.metadata.costUsd.toFixed(4)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="text-xs space-y-0.5">
                    {message.metadata.usage ? (
                      <>
                        <p>Input: {message.metadata.usage.input_tokens?.toLocaleString()} tokens</p>
                        <p>Output: {message.metadata.usage.output_tokens?.toLocaleString()} tokens</p>
                      </>
                    ) : null}
                    <p>Cost: ${message.metadata.costUsd.toFixed(4)}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  )
}
