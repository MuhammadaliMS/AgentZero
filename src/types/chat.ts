// ─── Agentic Chat Message Model ─────────────────────────────────────────
// Parts-based message model for Claude-like agentic chat experience.
// Messages are composed of interleaved parts instead of a single text string.

// ─── Message Part Types ─────────────────────────────────────────────────

export type MessagePartType =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_response'
  | 'integration_prompt'
  | 'subagent'
  | 'status'

export interface BaseMessagePart {
  id: string
  type: MessagePartType
  timestamp: number // Date.now()
}

export interface TextPart extends BaseMessagePart {
  type: 'text'
  content: string // Markdown text, incrementally appended during streaming
}

export interface ThinkingPart extends BaseMessagePart {
  type: 'thinking'
  content: string // Reasoning text, incrementally appended during streaming
  isStreaming: boolean
}

export interface ToolCallPart extends BaseMessagePart {
  type: 'tool_call'
  toolName: string
  toolInput: Record<string, unknown>
  displayName: string // Human-readable: "Reading Emails", "Checking Calendar"
  status: 'running' | 'completed' | 'failed'
  durationMs?: number
  resultPartId?: string // Links to the corresponding ToolResultPart
}

export interface ToolResultPart extends BaseMessagePart {
  type: 'tool_result'
  toolName: string
  content: string // Result summary
  success: boolean
  toolCallPartId: string // Links back to the ToolCallPart
}

export interface ApprovalRequestPart extends BaseMessagePart {
  type: 'approval_request'
  approvalId: string // UUID used to resolve the approval
  toolName: string
  toolInput: Record<string, unknown>
  title: string // "Send Slack DM to John"
  description: string // Detailed description of what will happen
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

export interface ApprovalResponsePart extends BaseMessagePart {
  type: 'approval_response'
  approvalId: string
  decision: 'approved' | 'rejected'
}

export interface IntegrationPromptPart extends BaseMessagePart {
  type: 'integration_prompt'
  integrationKey: string // e.g., 'gmail', 'slack', 'vanta'
  integrationName: string // e.g., 'Gmail', 'Slack', 'Vanta'
  reason: string // "To check your emails, I need access to Gmail"
  status: 'pending' | 'connected' | 'dismissed'
}

export interface SubagentPart extends BaseMessagePart {
  type: 'subagent'
  agentId: string
  displayName: string // "Strategy Analyst", "Compliance Specialist"
  status: 'running' | 'completed'
  summary?: string
}

export interface StatusPart extends BaseMessagePart {
  type: 'status'
  content: string // "Compacting context..." or "Session initialized"
}

export type MessagePart =
  | TextPart
  | ThinkingPart
  | ToolCallPart
  | ToolResultPart
  | ApprovalRequestPart
  | ApprovalResponsePart
  | IntegrationPromptPart
  | SubagentPart
  | StatusPart

// ─── Agentic Message Model ──────────────────────────────────────────────

export interface AgenticMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  createdAt: Date
  metadata?: {
    usage?: { input_tokens: number; output_tokens: number }
    costUsd?: number
    durationMs?: number
    error?: string
  }
}

// ─── Helper: Extract plain text content from parts ──────────────────────
// Used for DB storage and backward compatibility with flat content field.

export function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.content)
    .join('')
}

// ─── Helper: Generate unique part ID ────────────────────────────────────

let partCounter = 0
export function generatePartId(): string {
  partCounter += 1
  return `part-${Date.now()}-${partCounter}-${Math.random().toString(36).slice(2, 6)}`
}

// ─── Helper: Map subagent IDs to display names ──────────────────────────

const SUBAGENT_DISPLAY_NAMES: Record<string, string> = {
  eve: 'Strategy Analyst',
  cole: 'Program Manager',
  rhea: 'Compliance Specialist',
}

export function getSubagentDisplayName(agentId: string): string {
  return SUBAGENT_DISPLAY_NAMES[agentId] || `Specialist (${agentId})`
}
