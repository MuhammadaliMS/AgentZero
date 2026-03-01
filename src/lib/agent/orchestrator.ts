import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { resolve as resolvePath } from 'path'
import { existsSync } from 'fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { buildAgentContext, getRequiredToolSets } from './context-builder'
import {
  logWorkerExecution,
  completeWorkerExecution,
  buildSdkHooks,
  type HookContext,
} from './hooks'
import { eveAgent } from './workers/eve'
import { coleAgent } from './workers/cole'
import { rheaAgent } from './workers/rhea'
import { createApprovalRequest } from './approval-store'
import {
  getRequiredIntegration,
  buildApprovalTitle,
  buildApprovalDescription,
  formatToolDisplayName,
} from './tool-metadata'
import { ensureWorkspace, getWorkspacePath } from './workspace'

// ─── Model Configuration ─────────────────────────────────────────────────
// Supports Anthropic (default), OpenRouter, or any Anthropic-compatible proxy.
//
// To use OpenRouter, set these env vars:
//   ANTHROPIC_BASE_URL=https://openrouter.ai/api
//   ANTHROPIC_AUTH_TOKEN=sk-or-v1-...     (your OpenRouter key)
//   ANTHROPIC_API_KEY=""                   (must be explicitly empty)
//   CAPTAIN_MODEL=moonshotai/kimi-k2.5    (or z-ai/glm-5, etc.)
//
// To use default Anthropic:
//   Just set ANTHROPIC_API_KEY (no base URL override needed)
//
const CAPTAIN_MODEL = process.env.CAPTAIN_MODEL || 'claude-sonnet-4-6'

// Tool creators
import { createSupabaseTools } from './tools/supabase-tools'
import { createMemoryTools } from './tools/memory-tools'
import { createSlackTools } from './tools/slack-tools'
import { createEmailTools } from './tools/email-tools'
import { createCalendarTools } from './tools/calendar-tools'
import { createVantaTools } from './tools/vanta-tools'
import { createIntegrationTools } from './tools/integration-tools'

// ─── Types ────────────────────────────────────────────────────────────────

export interface RunCaptainParams {
  orgId: string
  userId: string
  message: string
  conversationId: string
  sessionId?: string
  abortController?: AbortController
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Direct SSE emission callback — bypasses the generator yield cycle.
   *  Used by permissionGateHook to emit events while blocking. */
  onEmitEvent?: (event: StreamEvent) => void
}

export interface StreamEvent {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'subagent_start'
    | 'subagent_stop'
    | 'task_started'
    | 'task_progress'
    | 'task_completed'
    | 'status'
    | 'prompt_suggestion'
    | 'done'
    | 'error'
    // Agentic chat: approval flow
    | 'approval_required'
    | 'approval_resolved'
    // Agentic chat: integration prompting
    | 'integration_required'
    | 'integration_resolved'
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolDisplayName?: string
  agentId?: string
  taskId?: string
  sessionId?: string
  conversationId?: string
  // Approval fields
  approvalId?: string
  approvalTitle?: string
  approvalDescription?: string
  approvalDecision?: 'approved' | 'rejected' | 'expired'
  // Integration prompt fields
  integrationKey?: string
  integrationName?: string
  decision?: string // 'connected' | 'dismissed' for integration_resolved
  // Metrics
  usage?: {
    input_tokens: number
    output_tokens: number
  }
  costUsd?: number
  durationMs?: number
  numTurns?: number
  modelUsage?: Record<string, { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }>
}

// ─── Tool Permission System ──────────────────────────────────────────────
// Tools that require human-in-the-loop approval before execution.
// Enforced by the permissionGateHook PreToolUse hook at the SDK level.

const TOOLS_REQUIRING_APPROVAL = new Set([
  'send_slack_dm',
  'send_approval_message',
  'draft_email',
  'create_commitment',
  'create_action',
  'resolve_action',
])

const READ_ONLY_TOOLS = new Set([
  'recall_memory',
  'query_commitments',
  'query_actions',
  'read_recent_emails',
  'search_emails',
  'get_today_events',
  'get_week_events',
  'find_free_slots',
  'get_compliance_overview',
  'list_failing_controls',
  'get_audit_status',
  'list_connected_integrations',
  'get_integration_health',
])

// ─── Conversation History → Prompt Builder ──────────────────────────────

/**
 * Build a prompt that includes prior conversation history for multi-turn context.
 *
 * The SDK's query() accepts `string | AsyncIterable<SDKUserMessage>`, but the
 * AsyncIterable form is designed for streaming NEW messages during execution —
 * not for replaying historical turns. Since we use `persistSession: false`
 * (Vercel's /tmp is ephemeral), the `resume` option can't load prior context
 * from disk either.
 *
 * Solution: prepend conversation history as structured XML context to the
 * current user message. The model natively understands this format and uses
 * it for multi-turn coherence (remembering prior answers, avoiding repetition,
 * resolving references like "the email I mentioned earlier").
 *
 * Limits: Last 50 messages, max 12,000 characters of history to avoid
 * overwhelming the context window. Older messages are trimmed from the front.
 */
const MAX_HISTORY_MESSAGES = 50
const MAX_HISTORY_CHARS = 12_000

/**
 * Sanitize a history message to prevent prompt injection via the XML block.
 * Strips the exact tags we use as delimiters so an attacker can't inject
 * content outside the <conversation_history> block. Also removes control chars.
 *
 * P2-11: Defend against prompt injection through conversation history.
 */
function sanitizeHistoryContent(content: string): string {
  return content
    // Remove the XML delimiters we use — prevents breaking out of the block.
    // Use flexible regex to catch variants with whitespace (e.g. "< /conversation_history >").
    .replace(/<\s*\/?\s*conversation_history\s*>/gi, '[conversation_history]')
    // Also strip other XML-like tags that could be used for prompt injection
    // targeting the model's system/instruction parsing.
    .replace(/<\s*\/?\s*(system|instructions?|prompt|tool_result|function_call)\s*>/gi, '[$1]')
    // Remove ASCII control characters (non-printable, except common whitespace)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function buildPromptWithHistory(
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  currentMessage: string
): string {
  if (!conversationHistory || conversationHistory.length === 0) {
    return currentMessage
  }

  // Take the most recent messages (cap count)
  const recentHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES)

  // Format messages and enforce character limit
  let totalChars = 0
  const formattedMessages: string[] = []

  // Build from newest to oldest, then reverse — so we keep the most recent context
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const msg = recentHistory[i]
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant'
    // P2-11: Sanitize content to prevent XML injection through history
    const safeContent = sanitizeHistoryContent(msg.content)
    const formatted = `${roleLabel}: ${safeContent}`

    if (totalChars + formatted.length > MAX_HISTORY_CHARS) {
      break // Stop adding older messages once we hit the char limit
    }

    totalChars += formatted.length
    formattedMessages.unshift(formatted) // prepend to maintain chronological order
  }

  if (formattedMessages.length === 0) {
    return currentMessage
  }

  return `<conversation_history>
The following is our conversation so far. Use this context to maintain continuity, avoid repeating information, and resolve references to prior messages.

${formattedMessages.join('\n\n')}
</conversation_history>

${currentMessage}`
}

// ─── Main Agent Entry Point ──────────────────────────────────────────────

/**
 * Run the Captain agent and yield stream events.
 *
 * Uses the full Claude Agent SDK feature set:
 * - Built-in tools (Bash, Read, Write, Glob, Grep) with ephemeral workspace
 * - Native hooks (PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, PreCompact, SubagentStart/Stop, Stop, Notification)
 * - AbortController for cancellation
 * - Adaptive thinking for executive-level reasoning
 * - PreToolUse permission gate hook for sensitive actions + built-in tool sandboxing
 * - maxBudgetUsd cost control
 * - Full SDK message type processing (20+ types)
 * - Session management (resume, persist)
 * - Prompt suggestions for follow-up questions
 * - Workspace with CLAUDE.md (auto-read by SDK) and recipe templates
 * - Output verification hooks for deterministic quality checks
 * - Multi-turn conversation history via structured prompt context
 */
export async function* runCaptain(
  params: RunCaptainParams
): AsyncGenerator<StreamEvent> {
  const { orgId, userId, message, abortController, sessionId } = params
  const startTime = Date.now()

  // Log execution start
  const executionId = await logWorkerExecution({
    org_id: orgId,
    conversation_id: params.conversationId,
    worker: 'captain',
    trigger: 'chat',
    input_summary: message.slice(0, 200),
    status: 'running',
  })

  try {
    // Build context: loads profile, connected integrations, dynamic system prompt
    const context = await buildAgentContext(orgId, userId)
    const requiredToolSets = getRequiredToolSets(context.connectedIntegrations)

    // Create ephemeral workspace for built-in tools (Bash, Read, Write, Glob, Grep)
    const workspacePath = getWorkspacePath(orgId, params.conversationId)
    await ensureWorkspace(orgId, params.conversationId)

    // Build MCP servers based on connected integrations
    const mcpServers = buildMcpServers(orgId, requiredToolSets, params.conversationId)

    // ─── Build SDK Hooks ──────────────────────────────────────────
    // These native hook callbacks provide real-time observability
    // into tool calls, subagent delegation, and notifications.

    // We collect events emitted by hooks to yield them from this generator
    const hookEventQueue: StreamEvent[] = []

    const hookContext: HookContext = {
      orgId,
      conversationId: params.conversationId,
      executionId,
      workspacePath,
      // Cast needed: StreamEvent has a narrow `type` union, HookContext uses a wider
      // HookEmittableEvent to avoid circular imports. At runtime they're compatible.
      onEmitEvent: params.onEmitEvent as HookContext['onEmitEvent'],
      onToolUse: (toolName, input) => {
        hookEventQueue.push({
          type: 'tool_use',
          toolName,
          toolInput: input,
          toolDisplayName: formatToolDisplayName(toolName),
        })
      },
      onToolResult: (toolName, durationMs, success) => {
        hookEventQueue.push({
          type: 'tool_result',
          toolName,
          content: success ? 'success' : 'failed',
          durationMs,
        })
      },
      onToolFailure: (toolName, error, durationMs) => {
        hookEventQueue.push({
          type: 'tool_result',
          toolName,
          content: `failed: ${error}`,
          durationMs,
        })
      },
      onSubagentStart: (agentId) => {
        hookEventQueue.push({
          type: 'subagent_start',
          agentId,
          content: `Delegating to specialist: ${agentId}`,
        })
      },
      onSubagentStop: (agentId, lastMessage) => {
        hookEventQueue.push({
          type: 'subagent_stop',
          agentId,
          content: lastMessage?.slice(0, 200),
        })
      },
      onNotification: (notificationType, title, notificationMessage) => {
        hookEventQueue.push({
          type: 'status',
          content: `[${notificationType}] ${title}: ${notificationMessage}`,
        })
      },
    }

    // ─── Tool Classification ──────────────────────────────────
    // Built-in SDK tools — checked before MCP name normalization
    const BUILTIN_TOOLS = new Set([
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
    ])
    const BUILTIN_READ_ONLY = new Set(['Read', 'Glob', 'Grep'])

    // Normalize MCP-prefixed tool names to their base name.
    // MCP tools arrive as "mcp__<server>__<tool_name>" (double underscores)
    // e.g. "mcp__email__search_emails" → extract "search_emails".
    const normalizeName = (name: string): string => {
      // Already a known name?
      if (
        READ_ONLY_TOOLS.has(name) ||
        TOOLS_REQUIRING_APPROVAL.has(name) ||
        getRequiredIntegration(name)
      ) {
        return name
      }

      // Direct strip: "mcp__email__search_emails" → "search_emails"
      if (name.startsWith('mcp__')) {
        const doubleUnderscoreParts = name.split('__')
        if (doubleUnderscoreParts.length >= 3) {
          const candidate = doubleUnderscoreParts.slice(2).join('__')
          if (
            READ_ONLY_TOOLS.has(candidate) ||
            TOOLS_REQUIRING_APPROVAL.has(candidate) ||
            getRequiredIntegration(candidate)
          ) {
            return candidate
          }
        }
      }

      // Fallback: progressively try shorter suffixes (split on single _)
      const parts = name.split('_').filter(p => p !== '')
      for (let i = 1; i < parts.length; i++) {
        const candidate = parts.slice(i).join('_')
        if (
          READ_ONLY_TOOLS.has(candidate) ||
          TOOLS_REQUIRING_APPROVAL.has(candidate) ||
          getRequiredIntegration(candidate)
        ) {
          return candidate
        }
      }
      return name
    }

    const hooks = buildSdkHooks(hookContext)

    // ─── PreToolUse Permission Gate ───────────────────────────────
    // This PreToolUse hook enforces ALL permission decisions. It runs
    // before every tool call (fires with every permissionMode, including
    // bypassPermissions — unlike canUseTool which doesn't fire for MCP
    // tools with dontAsk/bypassPermissions).
    //
    // Checks (in order):
    // 1. Built-in tool security (Write/Edit path restriction, Bash denylist)
    // 2. Integration gating → BLOCK until user connects via OAuth popup
    // 3. Sensitive tools → BLOCK until user approves in chat UI
    // 4. Default → allow
    //
    // For blocking checks (integration + approval), the hook:
    //   - Creates a DB-backed approval request (reuses pending_approvals table)
    //   - Emits SSE event directly via onEmitEvent (bypasses hookEventQueue
    //     since the generator loop is paused while the hook blocks)
    //   - Awaits a Promise that resolves when the user acts
    //   - Returns permissionDecision: 'allow' (resume) or 'deny' (skip)

    const permissionGateHook = async (
      input: Record<string, unknown>,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal }
    ): Promise<Record<string, unknown>> => {
      const toolName = input.tool_name as string
      const toolInput = (input.tool_input as Record<string, unknown>) || {}

      // ─── Built-in tool security ─────────────────────────────────
      if (BUILTIN_TOOLS.has(toolName)) {
        // Read-only built-in tools → always allow
        if (BUILTIN_READ_ONLY.has(toolName)) {
          return { continue: true }
        }

        // Write tool → restrict to workspace path
        if (toolName === 'Write') {
          const rawPath = (toolInput as { file_path?: string }).file_path || ''
          const filePath = resolvePath(rawPath)
          if (!filePath.startsWith('/tmp/zerowing-workspace/')) {
            console.log(`[PreToolUse:PermissionGate] Write blocked: ${rawPath} → ${filePath} (outside workspace)`)
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Write access is restricted to the workspace directory (/tmp/zerowing-workspace/).',
              },
            }
          }
        }

        // Bash → command denylist
        if (toolName === 'Bash') {
          const rawCmd = (toolInput as { command?: string }).command ?? ''
          const cmd = rawCmd.toLowerCase()
          const DENIED_PATTERNS = [
            /\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bnetcat\b/, /\bncat\b/,
            /\bssh\b/, /\bscp\b/, /\bsftp\b/, /\bftp\b/, /\btelnet\b/,
            /\bpython[23]?\s+-c\b/, /\bnode\s+-e\b/, /\bruby\s+-e\b/, /\bperl\s+-e\b/,
            /\brm\s+-[rRf]/, /\brmdir\b/,
            /\bsudo\b/,
            /\beval\b/, /base64\s.*-d.*\|\s*(?:sh|bash|zsh)/,
            /\/usr\/bin\/curl/, /\/usr\/bin\/wget/,
          ]
          const DENIED_PATHS = ['/etc/', '/proc/', '/sys/', '/root/', '/var/']
          const isDenied =
            DENIED_PATTERNS.some((p) => p.test(cmd)) ||
            DENIED_PATHS.some((p) => cmd.includes(p))

          if (isDenied) {
            console.log(`[PreToolUse:PermissionGate] Bash blocked: command contains restricted pattern`)
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'This Bash command contains restricted operations.',
              },
            }
          }
        }

        // Edit tool → restrict to workspace path
        if (toolName === 'Edit') {
          const rawPath = (toolInput as { file_path?: string }).file_path || ''
          const filePath = resolvePath(rawPath)
          if (!filePath.startsWith('/tmp/zerowing-workspace/')) {
            console.log(`[PreToolUse:PermissionGate] Edit blocked: ${rawPath} → ${filePath} (outside workspace)`)
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Edit access is restricted to the workspace directory (/tmp/zerowing-workspace/).',
              },
            }
          }
        }

        // All other built-in tools → allow
        return { continue: true }
      }

      // ─── MCP Tool Checks ────────────────────────────────────────
      const baseName = normalizeName(toolName)
      console.log(`[PreToolUse:PermissionGate] tool="${toolName}" base="${baseName}"`)

      // 1. Integration check FIRST — BLOCK if required integration is not connected.
      const requiredIntegration = getRequiredIntegration(baseName)
      if (requiredIntegration && !context.connectedIntegrations.includes(requiredIntegration.key)) {
        const displayName = formatToolDisplayName(baseName)

        // Reuse approval-store to create a blocking Promise.
        const { approvalId, promise } = await createApprovalRequest(
          'INTEGRATION_CONNECT',
          {
            integration_key: requiredIntegration.key,
            integration_name: requiredIntegration.name,
            triggering_tool: baseName,
          },
          params.conversationId,
          orgId
        )

        // Emit integration_required DIRECTLY to SSE using onEmitEvent.
        // CRITICAL: hookEventQueue won't drain while this hook blocks the SDK.
        params.onEmitEvent?.({
          type: 'integration_required',
          approvalId,
          integrationKey: requiredIntegration.key,
          integrationName: requiredIntegration.name,
          toolName: baseName,
          toolDisplayName: displayName,
          content: `To ${displayName.toLowerCase()}, I need access to ${requiredIntegration.name}.`,
        })

        console.log(
          `[PreToolUse:PermissionGate] Integration required: ${requiredIntegration.key} ` +
          `for ${baseName} — blocking until user connects (approvalId: ${approvalId})`
        )

        // BLOCK: await user connection (or timeout → auto-dismiss after 2 min)
        const decision = await promise

        // Emit resolution via hookEventQueue (safe now — promise resolved)
        hookEventQueue.push({
          type: 'integration_resolved',
          approvalId,
          integrationKey: requiredIntegration.key,
          decision: decision === 'approve' ? 'connected' : 'dismissed',
        })

        if (decision === 'approve') {
          context.connectedIntegrations.push(requiredIntegration.key)
          console.log(`[PreToolUse:PermissionGate] Integration connected: ${requiredIntegration.key} — resuming tool`)
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          }
        } else {
          console.log(`[PreToolUse:PermissionGate] Integration dismissed: ${requiredIntegration.key}`)
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `The user chose not to connect ${requiredIntegration.name}. Do not retry this integration — acknowledge and move on to what you can help with.`,
            },
          }
        }
      }

      // 2. Read-only tools — always allow (after integration check)
      if (READ_ONLY_TOOLS.has(baseName)) {
        return { continue: true }
      }

      // 3. Sensitive tools — require user approval in chat UI
      if (TOOLS_REQUIRING_APPROVAL.has(baseName)) {
        const { approvalId, promise } = await createApprovalRequest(
          baseName,
          toolInput,
          params.conversationId,
          orgId
        )

        // Emit approval_required DIRECTLY to SSE (same reason as integration)
        params.onEmitEvent?.({
          type: 'approval_required',
          approvalId,
          toolName: baseName,
          toolInput: toolInput,
          toolDisplayName: formatToolDisplayName(baseName),
          approvalTitle: buildApprovalTitle(baseName, toolInput),
          approvalDescription: buildApprovalDescription(baseName, toolInput),
        })

        console.log(`[PreToolUse:PermissionGate] Approval required for ${baseName} (approvalId: ${approvalId})`)

        const decision = await promise

        hookEventQueue.push({
          type: 'approval_resolved',
          approvalId,
          toolName: baseName,
          approvalDecision: decision === 'approve' ? 'approved' : 'rejected',
        })

        if (decision === 'approve') {
          console.log(`[PreToolUse:PermissionGate] User approved: ${baseName}`)
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          }
        } else {
          console.log(`[PreToolUse:PermissionGate] User rejected: ${baseName}`)
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'The user chose not to proceed with this action.',
            },
          }
        }
      }

      // 4. Default: allow all other tools
      return { continue: true }
    }

    // Prepend permission gate as the first PreToolUse hook.
    // Cast needed: local HookCallback type is narrower than SDK's actual
    // SyncHookJSONOutput (which includes hookSpecificOutput.permissionDecision).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks.PreToolUse = [
      { hooks: [permissionGateHook as any] },
      ...(hooks.PreToolUse || []),
    ]

    // ─── Run the Agent ────────────────────────────────────────────

    // Build prompt with conversation history for multi-turn context.
    // This gives the agent awareness of prior turns so it can:
    // - Avoid repeating information already shared
    // - Resolve references ("the email I mentioned", "that commitment")
    // - Maintain consistent tone and follow-up on prior threads
    const prompt = buildPromptWithHistory(params.conversationHistory, message)

    // ─── Resolve CLI path for Vercel ────────────────────────────
    // Turbopack bundles the SDK (ESM), so require.resolve returns a
    // numeric module ID, not a file path. We use a hardcoded path
    // based on Vercel's /var/task layout + outputFileTracingIncludes.
    const cliPath = resolvePath(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')
    if (!existsSync(cliPath)) {
      console.warn(`[SDK] cli.js not found at ${cliPath}`)
    }

    const agentQuery = query({
      prompt,
      options: {
        // System prompt with dynamic capabilities
        systemPrompt: context.systemPrompt,

        // Model — configurable via CAPTAIN_MODEL env var.
        // Default: claude-sonnet-4-6 (Anthropic)
        // OpenRouter examples: moonshotai/kimi-k2.5, z-ai/glm-5
        model: CAPTAIN_MODEL,

        // Effort level — high for thoughtful executive analysis.
        // Note: non-Anthropic models may ignore this, which is fine.
        effort: 'high',

        // Built-in SDK tools for file system composability + MCP tool servers
        tools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
        mcpServers,

        // Working directory — points to the ephemeral workspace
        cwd: workspacePath,

        // Subagent workers — specialist agents that the Captain delegates to.
        // Each has their own tools, prompts, and model configuration.
        agents: {
          eve: eveAgent,
          cole: coleAgent,
          rhea: rheaAgent,
        },

        // ─── Permission System ───────────────────────────────────
        // 'bypassPermissions' mode: the SDK won't prompt for interactive
        // consent (safe for server-side / non-TTY). canUseTool does NOT
        // fire with this mode. ALL permission enforcement is done in the
        // PreToolUse hook instead (see permissionGateHook above), which
        // fires with every permission mode including bypassPermissions.
        //
        // The PreToolUse hook handles:
        //   - Integration gating: blocks until user connects via OAuth
        //   - Sensitive tools: blocks until user approves in chat UI
        //   - Built-in tool security: path traversal, bash denylist
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // ─── Hooks ───────────────────────────────────────────────
        // Native SDK hooks for real-time observability.
        hooks,

        // ─── Execution Limits ────────────────────────────────────
        maxTurns: 30,
        maxBudgetUsd: 2.0, // Cost cap per query

        // ─── Streaming ───────────────────────────────────────────
        // Include partial messages for real-time text streaming
        includePartialMessages: true,

        // Enable prompt suggestions for follow-up questions
        promptSuggestions: true,

        // ─── CLI Executable Path ──────────────────────────────────
        // Turbopack bundles the SDK (ESM), so __dirname-based resolution
        // inside the SDK breaks. Point explicitly to cli.js included
        // via outputFileTracingIncludes in next.config.ts.
        pathToClaudeCodeExecutable: cliPath,

        // ─── Session Management ──────────────────────────────────
        // Resume session if provided, otherwise start fresh.
        // Session is not persisted to disk — we store in Supabase.
        ...(sessionId ? { resume: sessionId } : {}),
        persistSession: false,

        // ─── Cancellation ────────────────────────────────────────
        ...(abortController ? { abortController } : {}),

        // ─── Environment ─────────────────────────────────────────
        // HOME must point to /tmp on Vercel — the default HOME (/vercel)
        // is read-only and cli.js (Claude Code) needs to write config
        // files to ~/.claude/ during initialization.
        env: {
          ...process.env,
          HOME: process.env.VERCEL ? '/tmp' : (process.env.HOME || '/tmp'),
          ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY ?? '').trim(),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'zerowing-captain/1.0.0',
        },
      },
    })

    // ─── Process SDK Messages ─────────────────────────────────────

    let fullText = ''
    let totalUsage = { input_tokens: 0, output_tokens: 0 }
    let totalCost = 0
    let totalDurationMs = 0
    let totalTurns = 0
    let resultSessionId: string | undefined
    for await (const event of agentQuery) {
      // First, drain any queued hook events
      while (hookEventQueue.length > 0) {
        const hookEvent = hookEventQueue.shift()!
        yield hookEvent
      }

      // Process the SDK message
      const streamEvents = processSDKMessage(event)
      for (const streamEvent of streamEvents) {
        if (streamEvent.type === 'text' && streamEvent.content) {
          fullText += streamEvent.content
        }

        if (streamEvent.type === 'done') {
          totalUsage = streamEvent.usage || totalUsage
          totalCost = streamEvent.costUsd || 0
          totalDurationMs = streamEvent.durationMs || 0
          totalTurns = streamEvent.numTurns || 0
          resultSessionId = streamEvent.sessionId
        }

        yield streamEvent
      }
    }

    // Drain remaining hook events
    while (hookEventQueue.length > 0) {
      const hookEvent = hookEventQueue.shift()!
      yield hookEvent
    }

    // Ensure we always emit a done event
    if (totalCost === 0 && fullText.length > 0) {
      yield {
        type: 'done',
        sessionId: resultSessionId,
        usage: totalUsage,
        costUsd: totalCost,
        durationMs: totalDurationMs,
        numTurns: totalTurns,
      }
    }

    // Log completion to worker_executions
    const outputSummary = fullText.slice(0, 300) || '[NO TEXT]'
    if (executionId) {
      await completeWorkerExecution(executionId, {
        output_summary: outputSummary,
        status: 'completed',
        duration_ms: Date.now() - startTime,
        tokens_used: {
          input: totalUsage.input_tokens,
          output: totalUsage.output_tokens,
        },
        cost_usd: totalCost,
      })
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    if (executionId) {
      await completeWorkerExecution(executionId, {
        status: 'failed',
        duration_ms: Date.now() - startTime,
        error: errorMessage, // Full error saved to DB for debugging
      })
    }

    // P1-8: Log full error server-side but yield a generic message to the client.
    // This prevents leaking stack traces, internal paths, or API details.
    const isAbort = errorMessage.includes('abort') || params.abortController?.signal.aborted
    if (!isAbort) {
      console.error(`[runCaptain] Error for org=${orgId}:`, errorMessage)
      console.error(`[runCaptain] Full error:`, error)
      console.error(`[runCaptain] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}, length: ${(process.env.ANTHROPIC_API_KEY ?? '').length}`)
    }
    yield {
      type: 'error',
      content: isAbort
        ? 'Request cancelled.'
        : 'An error occurred while processing your request.',
    }
  }
}

// ─── MCP Server Builder ──────────────────────────────────────────────────

/**
 * Build MCP server configs based on which tool sets are needed.
 * Only loads tools for connected integrations (selective context injection).
 */
function buildMcpServers(
  orgId: string,
  requiredToolSets: string[],
  conversationId?: string | null
): Record<string, ReturnType<typeof createSdkMcpServer>> {
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {}

  const toolSetMap: Record<
    string,
    () => ReturnType<typeof createSdkMcpServer>
  > = {
    supabase: () =>
      createSdkMcpServer({
        name: 'supabase-tools',
        tools: createSupabaseTools(orgId, conversationId),
      }),
    memory: () =>
      createSdkMcpServer({
        name: 'memory-tools',
        tools: createMemoryTools(orgId),
      }),
    integration: () =>
      createSdkMcpServer({
        name: 'integration-tools',
        tools: createIntegrationTools(orgId),
      }),
    slack: () =>
      createSdkMcpServer({
        name: 'slack-tools',
        tools: createSlackTools(orgId),
      }),
    email: () =>
      createSdkMcpServer({
        name: 'email-tools',
        tools: createEmailTools(orgId),
      }),
    calendar: () =>
      createSdkMcpServer({
        name: 'calendar-tools',
        tools: createCalendarTools(orgId),
      }),
    vanta: () =>
      createSdkMcpServer({
        name: 'vanta-tools',
        tools: createVantaTools(orgId),
      }),
  }

  for (const toolSet of requiredToolSets) {
    const creator = toolSetMap[toolSet]
    if (creator) {
      try {
        servers[toolSet] = creator()
      } catch (e) {
        console.error(`[MCP:Build] Failed to create server "${toolSet}":`, e)
      }
    }
  }

  return servers
}

// ─── SDK Message Processing ──────────────────────────────────────────────

/**
 * Process an SDK message into stream events for the client.
 *
 * Handles ALL 20+ SDK message types:
 * - assistant: Full assistant messages with text/thinking/tool_use blocks
 * - stream_event: Partial streaming deltas (text, thinking)
 * - result: Success or error completion with usage data
 * - system (init): Session initialization info
 * - system (status): Status updates (e.g., compacting)
 * - system (task_started): Background task started
 * - system (task_progress): Background task progress
 * - system (task_notification): Background task completed/failed
 * - system (hook_started/progress/response): Hook execution events
 * - system (compact_boundary): Context compaction events
 * - system (files_persisted): File persistence events
 * - tool_progress: Long-running tool progress
 * - tool_use_summary: Summary of preceding tool uses
 * - auth_status: Authentication status changes
 * - user: User message echoes (replays)
 * - prompt_suggestion: Suggested follow-up prompts
 */
function processSDKMessage(msg: SDKMessage): StreamEvent[] {
  const events: StreamEvent[] = []

  switch (msg.type) {
    // ─── Assistant Message (Full) ─────────────────────────────────
    // NOTE: Text and thinking blocks are already streamed incrementally via
    // stream_event (content_block_delta). Tool-use blocks are already emitted
    // by the PreToolUse hook (with richer metadata like displayName).
    // We only extract errors from assistant messages to avoid duplicates.
    case 'assistant': {
      if (msg.error) {
        // P1-8: Log full error server-side but sanitize for client.
        // msg.error could contain internal paths, stack traces, or API details.
        console.error(`[SDK:Assistant] Error:`, msg.error)
        events.push({
          type: 'error',
          content: 'The assistant encountered an error processing the response.',
        })
      }
      break
    }

    // ─── Streaming Events (Partial) ───────────────────────────────
    case 'stream_event': {
      const event = msg.event
      if (event.type === 'content_block_delta') {
        const delta = event.delta as {
          type: string
          text?: string
          thinking?: string
        }
        if (delta.type === 'text_delta' && delta.text) {
          events.push({ type: 'text', content: delta.text })
        }
        if (delta.type === 'thinking_delta' && (delta.text || delta.thinking)) {
          events.push({
            type: 'thinking',
            content: delta.text || delta.thinking,
          })
        }
      }
      break
    }

    // ─── Result (Completion) ──────────────────────────────────────
    case 'result': {
      if (msg.subtype === 'success') {
        events.push({
          type: 'done',
          sessionId: msg.session_id,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
          },
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          modelUsage: msg.modelUsage as StreamEvent['modelUsage'],
        })
      } else {
        // Error result — could be max_turns, max_budget, execution error.
        // P1-8: Do not expose raw error details (msg.errors) to the client.
        const errorSubtype = msg.subtype.replace('error_', '')
        console.error(`[SDK:Result] Error subtype: ${errorSubtype}, errors:`, msg.errors)
        events.push({
          type: 'error',
          content: `Agent stopped: ${errorSubtype}.`,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
          },
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        })
      }
      break
    }

    // ─── System Messages ──────────────────────────────────────────
    case 'system': {
      // SDKMessage with type 'system' covers multiple subtypes.
      // We cast through unknown to avoid TS overlap complaints.
      const sysMsg = msg as unknown as { subtype: string; [key: string]: unknown }

      switch (sysMsg.subtype) {
        case 'init': {
          // Session initialized — log tools and MCP servers
          const initMsg = sysMsg as unknown as {
            tools: string[]
            mcp_servers: { name: string; status: string }[]
            model: string
            agents?: string[]
          }
          console.log(
            `[SDK:Init] Model: ${initMsg.model}, Tools: ${initMsg.tools.length}, MCP: ${initMsg.mcp_servers.length}, Agents: ${initMsg.agents?.join(', ') || 'none'}`
          )
          events.push({
            type: 'status',
            content: `Session initialized with ${initMsg.tools.length} tools and ${initMsg.mcp_servers.length} MCP servers`,
          })
          break
        }

        case 'status': {
          const statusMsg = sysMsg as unknown as { status: string | null }
          if (statusMsg.status === 'compacting') {
            events.push({
              type: 'status',
              content: 'Compacting conversation context...',
            })
          }
          break
        }

        case 'task_started': {
          const taskMsg = sysMsg as unknown as {
            task_id: string
            description: string
            task_type?: string
          }
          events.push({
            type: 'task_started',
            taskId: taskMsg.task_id,
            content: taskMsg.description,
          })
          break
        }

        case 'task_progress': {
          const taskMsg = sysMsg as unknown as {
            task_id: string
            description: string
            usage: {
              total_tokens: number
              tool_uses: number
              duration_ms: number
            }
            last_tool_name?: string
          }
          events.push({
            type: 'task_progress',
            taskId: taskMsg.task_id,
            content: taskMsg.description,
            toolName: taskMsg.last_tool_name,
          })
          break
        }

        case 'task_notification': {
          const taskMsg = sysMsg as unknown as {
            task_id: string
            status: 'completed' | 'failed' | 'stopped'
            summary: string
            usage?: {
              total_tokens: number
              tool_uses: number
              duration_ms: number
            }
          }
          events.push({
            type: 'task_completed',
            taskId: taskMsg.task_id,
            content: taskMsg.summary,
          })
          break
        }

        case 'hook_started':
        case 'hook_progress':
        case 'hook_response': {
          // Hook execution events — log for debugging, don't stream to client
          const hookMsg = sysMsg as unknown as {
            hook_name: string
            hook_event: string
          }
          console.log(
            `[SDK:Hook] ${sysMsg.subtype}: ${hookMsg.hook_event}/${hookMsg.hook_name}`
          )
          break
        }

        case 'compact_boundary': {
          const compactMsg = sysMsg as unknown as {
            compact_metadata: { trigger: string; pre_tokens: number }
          }
          console.log(
            `[SDK:Compact] Trigger: ${compactMsg.compact_metadata.trigger}, Pre-tokens: ${compactMsg.compact_metadata.pre_tokens}`
          )
          break
        }

        case 'files_persisted': {
          // File persistence events — not relevant for our server-side agent
          break
        }

        default: {
          console.log(`[SDK:System] Unhandled subtype: ${sysMsg.subtype}`)
          break
        }
      }
      break
    }

    // ─── Tool Progress (Long-running tools) ───────────────────────
    case 'tool_progress': {
      const toolMsg = msg as unknown as {
        tool_name: string
        elapsed_time_seconds: number
        task_id?: string
      }
      events.push({
        type: 'status',
        content: `Tool ${toolMsg.tool_name} running (${toolMsg.elapsed_time_seconds}s)...`,
        toolName: toolMsg.tool_name,
        taskId: toolMsg.task_id,
      })
      break
    }

    // ─── Tool Use Summary ─────────────────────────────────────────
    case 'tool_use_summary': {
      const summaryMsg = msg as unknown as { summary: string }
      events.push({
        type: 'status',
        content: summaryMsg.summary,
      })
      break
    }

    // ─── Auth Status ──────────────────────────────────────────────
    case 'auth_status': {
      const authMsg = msg as unknown as {
        isAuthenticating: boolean
        error?: string
      }
      if (authMsg.error) {
        events.push({
          type: 'error',
          content: `Authentication error: ${authMsg.error}`,
        })
      }
      break
    }

    // ─── User Message Replay ──────────────────────────────────────
    case 'user': {
      // User message replays during resume — we don't need to emit these
      break
    }

    // ─── Prompt Suggestion ────────────────────────────────────────
    // This is a message type that may exist in the SDK union type
    // but might not have an explicit type field match. Handle gracefully.
    default: {
      // Check for prompt_suggestion type (may vary by SDK version)
      const unknownMsg = msg as { type: string; suggestion?: string; prompt?: string }
      if (unknownMsg.type === 'prompt_suggestion') {
        events.push({
          type: 'prompt_suggestion',
          content: unknownMsg.suggestion || unknownMsg.prompt,
        })
      } else {
        console.log(`[SDK:Unknown] Message type: ${unknownMsg.type}`)
      }
      break
    }
  }

  return events
}
