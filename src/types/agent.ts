// ─── Agent Types ─────────────────────────────────────────────────────────
// Types shared across the agent system. The primary StreamEvent type is
// defined in src/lib/agent/orchestrator.ts and re-exported here for
// convenience. Message types for the chat UI are in src/types/chat.ts.

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: {
    tools_used?: string[]
    worker_delegated?: string
    parts?: unknown[]
    cost_usd?: number
    usage?: { input_tokens: number; output_tokens: number }
    error?: string
  }
  created_at: string
}

export interface AgentContext {
  org_id: string
  user_id: string
  profile: {
    full_name: string
    role: string
    title: string | null
    timezone: string
    communication_style: string
  }
  connected_integrations: string[]
  session_id?: string
}

export interface WorkerExecution {
  id: string
  org_id: string
  worker: string
  trigger: string | null
  input_summary: string | null
  output_summary: string | null
  status: 'running' | 'completed' | 'failed'
  duration_ms: number | null
  tokens_used: {
    input_tokens?: number
    output_tokens?: number
  } | null
  cost_usd: number | null
  error: string | null
  created_at: string
  completed_at: string | null
}
