import { createAdminClient } from '@/lib/supabase/admin'
import { formatToolDisplayName } from './tool-metadata'

// Minimal event shape for SSE emission — avoids circular dependency with orchestrator.ts.
// The full StreamEvent type is defined in orchestrator.ts; this subset covers what hooks need.
interface HookEmittableEvent {
  type: string
  content?: string
  toolName?: string
  toolDisplayName?: string
  integrationKey?: string
  integrationName?: string
  [key: string]: unknown
}

// ─── Execution Logging (DB) ───────────────────────────────────────────

interface ExecutionLog {
  org_id: string
  conversation_id?: string | null
  worker: string
  trigger: string
  input_summary: string
  output_summary?: string
  status: 'running' | 'completed' | 'failed'
  duration_ms?: number
  tokens_used?: { input: number; output: number }
  cost_usd?: number
  error?: string
}

function getSupabase() {
  return createAdminClient()
}

export async function logWorkerExecution(log: ExecutionLog): Promise<string | null> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('worker_executions')
    .insert({
      org_id: log.org_id,
      conversation_id: log.conversation_id || null,
      worker: log.worker,
      trigger: log.trigger,
      input_summary: log.input_summary,
      output_summary: log.output_summary || null,
      status: log.status,
      duration_ms: log.duration_ms || null,
      tokens_used: log.tokens_used || null,
      cost_usd: log.cost_usd || null,
      error: log.error || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Failed to log worker execution:', error.message)
    return null
  }

  return (data as { id: string }).id
}

export async function completeWorkerExecution(
  executionId: string,
  update: {
    output_summary?: string
    status: 'completed' | 'failed'
    duration_ms: number
    tokens_used?: { input: number; output: number }
    cost_usd?: number
    error?: string
  }
) {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('worker_executions')
    .update({
      output_summary: update.output_summary || null,
      status: update.status,
      duration_ms: update.duration_ms,
      tokens_used: update.tokens_used || null,
      cost_usd: update.cost_usd || null,
      error: update.error || null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId)

  if (error) {
    console.error('Failed to complete worker execution:', error.message)
  }
}

// ─── SDK Hook Callbacks ────────────────────────────────────────────────
// These plug into the `hooks` option of query() for real-time observability.
// SDK hook events we register:
//   PreToolUse, PostToolUse, PostToolUseFailure,
//   SubagentStart, SubagentStop, Stop,
//   Notification, SessionStart, PreCompact

export interface HookContext {
  orgId: string
  conversationId?: string | null
  executionId: string | null
  workspacePath?: string
  /** Direct SSE emission — for events that need to bypass the generator queue.
   *  Used by PostToolUse to emit integration_required events immediately.
   *  Typed as HookEmittableEvent (not StreamEvent) to avoid circular dependency. */
  onEmitEvent?: (event: HookEmittableEvent & Record<string, unknown>) => void
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void
  onToolResult?: (toolName: string, durationMs: number, success: boolean) => void
  onToolFailure?: (toolName: string, error: string, durationMs: number) => void
  /** Callback invoked with raw tool output data (for extraction pipeline). */
  onToolOutput?: (toolName: string, output: string) => void
  onSubagentStart?: (agentId: string) => void
  onSubagentStop?: (agentId: string, lastMessage?: string) => void
  onNotification?: (type: string, title: string, message: string) => void
}

// Generic hook callback type matching SDK expectations.
// NOTE: The SDK's HookInput union type is too broad for direct use in positioned hooks
// (e.g., PostToolUse hooks don't need to handle NotificationHookInput variants).
// We use Record<string, unknown> and access properties dynamically.
// IMPORTANT: The SDK PostToolUse passes `tool_response` (NOT `tool_result`).
type HookInput = Record<string, unknown>
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<{ continue?: boolean; suppressOutput?: boolean }>

interface HookCallbackMatcher {
  matcher?: string
  hooks: HookCallback[]
  timeout?: number
}

// ─── Output Verification ──────────────────────────────────────────────
// Deterministic checks on tool results to catch failures the agent might miss.
// Follows the "verification everywhere" principle from the SDK talk.

function verifyToolOutput(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null

  const res = result as Record<string, unknown>

  switch (toolName) {
    case 'send_slack_dm':
    case 'send_approval_message':
      // Slack send should return a message_ts
      if (!res.message_ts && !res.ts) {
        return `Slack send may have failed: no message_ts in response`
      }
      break

    case 'draft_email':
      // Email draft should have confirmation fields
      if (!res.id && !res.message_id && !res.threadId) {
        return `Email draft may have failed: no message ID in response`
      }
      break

    case 'create_commitment':
    case 'create_action':
      // DB writes should return an id
      if (!res.id) {
        return `${toolName} may have failed: no ID returned`
      }
      break
  }

  return null // No issues detected
}

/**
 * Build the full hooks map for the SDK query() options.
 * These are native SDK hook callbacks that fire during agent execution.
 *
 * Hook events we register:
 * - PreToolUse: Before every tool call → log, stream to client
 * - PostToolUse: After every tool call → timing, success tracking, output verification
 * - PostToolUseFailure: When a tool call fails → error logging
 * - SubagentStart: When worker delegation begins → log to DB
 * - SubagentStop: When worker finishes → log completion
 * - Stop: End of entire agent run → final cleanup
 * - Notification: Agent notifications → forward to client
 * - SessionStart: Session initialization → log model/tools info
 * - PreCompact: Before context compaction → observability
 */
export function buildSdkHooks(
  ctx: HookContext
): Record<string, HookCallbackMatcher[]> {
  const toolTimers = new Map<string, number>()

  return {
    // ─── PreToolUse: Fires before every tool call ───
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            const toolName = input.tool_name as string
            const toolInput = (input.tool_input as Record<string, unknown>) || {}
            const toolUseId = input.tool_use_id as string

            // Track timing for PostToolUse duration calculation
            toolTimers.set(toolUseId, Date.now())

            // Notify caller (for SSE streaming to client)
            ctx.onToolUse?.(toolName, toolInput)

            console.log(`[Hook:PreToolUse] ${toolName}`, Object.keys(toolInput))

            return { continue: true }
          },
        ],
      },
    ],

    // ─── PostToolUse: Fires after every tool call succeeds ───
    // Enhanced with:
    // 1. Integration-required marker detection → emits SSE events for connect cards
    // 2. Output verification for critical tools (Slack, email, commitments)
    PostToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            const toolName = input.tool_name as string
            const toolUseId = input.tool_use_id as string
            // SDK provides tool output as `tool_response` (not `tool_result`)
            const toolResult = input.tool_response

            const startTime = toolTimers.get(toolUseId) || Date.now()
            const durationMs = Date.now() - startTime
            toolTimers.delete(toolUseId)

            // Output verification — deterministic checks on tool results
            const verificationWarning = verifyToolOutput(toolName, toolResult)
            if (verificationWarning) {
              console.warn(`[Hook:PostToolUse:Verify] ${verificationWarning}`)
            }

            // Capture rich tool output for entity extraction (capped at 4000 chars)
            if (ctx.onToolOutput && toolResult) {
              try {
                const outputStr = typeof toolResult === 'string'
                  ? toolResult
                  : JSON.stringify(toolResult)
                if (outputStr.length > 20) {
                  ctx.onToolOutput(toolName, outputStr.slice(0, 4000))
                }
              } catch {}
            }

            ctx.onToolResult?.(toolName, durationMs, true)

            console.log(
              `[Hook:PostToolUse] ${toolName} completed in ${durationMs}ms`
            )

            return { continue: true }
          },
        ],
      },
    ],

    // ─── PostToolUseFailure: Fires when a tool call fails ───
    PostToolUseFailure: [
      {
        hooks: [
          async (input: HookInput) => {
            const toolName = input.tool_name as string
            const toolUseId = input.tool_use_id as string
            const errorMessage = (input.error as string) || 'Unknown error'

            const startTime = toolTimers.get(toolUseId) || Date.now()
            const durationMs = Date.now() - startTime
            toolTimers.delete(toolUseId)

            // Notify caller of failure
            ctx.onToolFailure?.(toolName, errorMessage, durationMs)
            ctx.onToolResult?.(toolName, durationMs, false)

            console.error(
              `[Hook:PostToolUseFailure] ${toolName} failed in ${durationMs}ms: ${errorMessage}`
            )

            return { continue: true }
          },
        ],
      },
    ],

    // ─── SubagentStart: Fires when a subagent (worker) is delegated to ───
    SubagentStart: [
      {
        hooks: [
          async (input: HookInput) => {
            const agentId = input.agent_id as string

            ctx.onSubagentStart?.(agentId)

            console.log(`[Hook:SubagentStart] Delegating to worker: ${agentId}`)

            // Log subagent execution to DB
            const supabase = getSupabase()
            await supabase
              .from('worker_executions')
              .insert({
                org_id: ctx.orgId,
                conversation_id: ctx.conversationId || null,
                worker: agentId,
                trigger: 'delegation',
                input_summary: `Delegated from captain`,
                status: 'running',
              })
              .then(({ error }) => {
                if (error)
                  console.error(
                    `Failed to log subagent start for ${agentId}:`,
                    error.message
                  )
              })

            return { continue: true }
          },
        ],
      },
    ],

    // ─── SubagentStop: Fires when a subagent finishes ───
    SubagentStop: [
      {
        hooks: [
          async (input: HookInput) => {
            const agentId = input.agent_id as string
            const lastMessage = input.last_assistant_message as string | undefined

            ctx.onSubagentStop?.(agentId, lastMessage)

            console.log(`[Hook:SubagentStop] Worker ${agentId} completed`)

            return { continue: true }
          },
        ],
      },
    ],

    // ─── Stop: Fires at the end of the agent run ───
    Stop: [
      {
        hooks: [
          async (input: HookInput) => {
            const lastMessage = input.last_assistant_message as string | undefined

            console.log(
              `[Hook:Stop] Agent run complete. Last message: ${lastMessage?.slice(0, 100) || '(none)'}...`
            )

            return { continue: true }
          },
        ],
      },
    ],

    // ─── Notification: Fires for agent notifications ───
    Notification: [
      {
        hooks: [
          async (input: HookInput) => {
            const message = input.message as string
            const title = (input.title as string) || ''
            const notificationType = input.notification_type as string

            ctx.onNotification?.(notificationType, title, message)

            console.log(
              `[Hook:Notification] [${notificationType}] ${title}: ${message}`
            )

            return { continue: true }
          },
        ],
      },
    ],

    // ─── SessionStart: Fires at session initialization ───
    // Useful for logging what model/tools/MCP servers are active.
    SessionStart: [
      {
        hooks: [
          async (input: HookInput) => {
            const model = input.model as string | undefined
            const tools = input.tools as string[] | undefined
            const mcpServers = input.mcp_servers as string[] | undefined

            console.log(
              `[Hook:SessionStart] Model: ${model || 'unknown'}, ` +
              `Tools: ${tools?.length || 0}, ` +
              `MCP: ${mcpServers?.length || 0}, ` +
              `Workspace: ${ctx.workspacePath || 'none'}`
            )

            return { continue: true }
          },
        ],
      },
    ],

    // ─── PreCompact: Fires before context compaction ───
    // Logs compaction events for observability — helps understand when
    // conversations are getting long and context is being trimmed.
    PreCompact: [
      {
        hooks: [
          async (input: HookInput) => {
            const preTokens = input.pre_tokens as number | undefined
            const trigger = input.trigger as string | undefined

            console.log(
              `[Hook:PreCompact] Trigger: ${trigger || 'auto'}, ` +
              `Pre-tokens: ${preTokens || 'unknown'}`
            )

            return { continue: true }
          },
        ],
      },
    ],
  }
}

