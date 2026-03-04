import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCaptainWithSDK, getSDKInfo, type AgentSDK } from '@/lib/agent/sdk-switch'
import type { StreamEvent } from '@/lib/agent/orchestrator'
import { cleanupConversationApprovals } from '@/lib/agent/approval-store'
import { runExtractionPipeline } from '@/lib/graph/extraction-pipeline'
import { isOpenAIConfigured } from '@/lib/openai/client'
import { waitUntil } from '@vercel/functions'
import type {
  MessagePart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  ApprovalRequestPart,
  SubagentPart,
} from '@/types/chat'
import type { Json } from '@/types/database'

// ─── Config ───────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes max for complex multi-tool queries

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum message length accepted from the client. */
const MAX_MESSAGE_LENGTH = 10_000

/** Rate limit: max requests per org per minute (counted via worker_executions). */
const RATE_LIMIT_RPM = 30

/** Max conversation history messages fetched from DB (matches orchestrator cap). */
const HISTORY_FETCH_LIMIT = 50

// ─── Server-side Parts Accumulator ───────────────────────────────────────────
// Builds a MessagePart[] from stream events for DB persistence.
// Mirrors the processEvent logic in use-chat.ts but runs server-side.

function accumulatePart(event: StreamEvent, parts: MessagePart[]): void {
  switch (event.type) {
    case 'text': {
      const last = parts[parts.length - 1]
      if (last?.type === 'text') {
        ;(last as TextPart).content += event.content ?? ''
      } else {
        parts.push({ id: crypto.randomUUID(), type: 'text', content: event.content ?? '', timestamp: Date.now() })
      }
      break
    }
    case 'thinking': {
      const last = parts[parts.length - 1]
      if (last?.type === 'thinking') {
        ;(last as ThinkingPart).content += event.content ?? ''
      } else {
        parts.push({ id: crypto.randomUUID(), type: 'thinking', content: event.content ?? '', isStreaming: false, timestamp: Date.now() })
      }
      break
    }
    case 'tool_use': {
      parts.push({
        id: crypto.randomUUID(),
        type: 'tool_call',
        toolName: event.toolName ?? '',
        toolInput: event.toolInput ?? {},
        displayName: event.toolDisplayName ?? event.toolName ?? '',
        status: 'running',
        timestamp: Date.now(),
      })
      break
    }
    case 'tool_result': {
      const lastTool = [...parts].reverse().find(
        (p) => p.type === 'tool_call' && (p as ToolCallPart).status === 'running'
      ) as ToolCallPart | undefined
      const resultId = crypto.randomUUID()
      parts.push({
        id: resultId,
        type: 'tool_result',
        toolName: event.toolName ?? '',
        content: event.content ?? '',
        success: !event.content?.startsWith('failed'),
        toolCallPartId: lastTool?.id ?? '',
        timestamp: Date.now(),
      })
      if (lastTool) {
        lastTool.status = event.content?.startsWith('failed') ? 'failed' : 'completed'
        if (event.durationMs) lastTool.durationMs = event.durationMs
        lastTool.resultPartId = resultId
      }
      break
    }
    case 'approval_required': {
      parts.push({
        id: crypto.randomUUID(),
        type: 'approval_request',
        approvalId: event.approvalId ?? '',
        toolName: event.toolName ?? '',
        toolInput: event.toolInput ?? {},
        title: event.approvalTitle ?? `Approve: ${event.toolName ?? ''}`,
        description: event.approvalDescription ?? '',
        status: 'pending',
        timestamp: Date.now(),
      } as ApprovalRequestPart)
      break
    }
    case 'approval_resolved': {
      const ap = parts.find(
        (p) => p.type === 'approval_request' && (p as ApprovalRequestPart).approvalId === event.approvalId
      ) as ApprovalRequestPart | undefined
      if (ap) ap.status = event.approvalDecision === 'approved' ? 'approved' : 'rejected'
      break
    }
    case 'integration_required':
    case 'integration_resolved':
      // No inline parts — integration events are handled entirely by the
      // permission bar in the frontend (use-chat.ts pendingIntegrations state).
      break
    case 'subagent_start': {
      parts.push({
        id: crypto.randomUUID(),
        type: 'subagent',
        agentId: event.agentId ?? '',
        displayName: event.agentId ?? '',
        status: 'running',
        timestamp: Date.now(),
      } as SubagentPart)
      break
    }
    case 'subagent_stop': {
      const sub = [...parts].reverse().find(
        (p) => p.type === 'subagent' && (p as SubagentPart).agentId === event.agentId
      ) as SubagentPart | undefined
      if (sub) {
        sub.status = 'completed'
        if (event.content) sub.summary = event.content
      }
      break
    }
    case 'status':
    case 'task_started':
    case 'task_progress':
    case 'task_completed': {
      if (event.content) {
        parts.push({ id: crypto.randomUUID(), type: 'status', content: event.content, timestamp: Date.now() })
      }
      break
    }
  }
}

// ─── GET: Fetch conversation messages ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const conversationId = request.nextUrl.searchParams.get('conversationId')
  if (!conversationId) {
    return NextResponse.json(
      { error: 'conversationId required' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  // ─── P0-1 / P1-9: Verify conversation ownership ───────────────────────────
  // Prevent IDOR: ensure the conversation belongs to the user's org.
  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const { data: conversation } = await admin
    .from('conversations')
    .select('org_id, user_id')
    .eq('id', conversationId)
    .single()

  if (!conversation || conversation.org_id !== profile.org_id || conversation.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: messages, error } = await admin
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }

  return NextResponse.json({ messages })
}

// ─── POST: Stream agent response via SSE ──────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await request.json()
  const {
    message,
    conversationId: existingConversationId,
    sessionId: existingSessionId,
  } = body as {
    message: string
    conversationId?: string
    sessionId?: string
  }

  // ─── P1-7: Message length validation ──────────────────────────────────────
  if (!message?.trim()) {
    return new Response('Message is required', { status: 400 })
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return new Response(
      `Message too long. Maximum ${MAX_MESSAGE_LENGTH} characters allowed.`,
      { status: 400 }
    )
  }

  // Get user's org_id
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id) {
    return new Response('Profile not found', { status: 404 })
  }

  const orgId = profile.org_id

  // ─── Load org SDK preference ───────────────────────────────────────────────
  let orgSdkOverride: AgentSDK | undefined
  {
    const { data: orgRow } = await admin
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .single()
    const orgSettings = (orgRow?.settings || {}) as Record<string, unknown>
    if (orgSettings.agent_sdk === 'openai' || orgSettings.agent_sdk === 'claude') {
      orgSdkOverride = orgSettings.agent_sdk as AgentSDK
    }
  }

  // ─── P0-1: Verify existingConversationId ownership ────────────────────────
  // Without this check, any authenticated user can inject any conversationId
  // from a different org and read/write to it (IDOR vulnerability).
  if (existingConversationId) {
    const { data: conv } = await admin
      .from('conversations')
      .select('org_id, user_id')
      .eq('id', existingConversationId)
      .single()

    if (!conv || conv.org_id !== orgId || conv.user_id !== user.id) {
      return new Response('Forbidden', { status: 403 })
    }
  }

  // ─── P0-4: Rate limiting ──────────────────────────────────────────────────
  // Count recent agent executions for this org. Using worker_executions since
  // it's already tracked and requires no new table. Max 30 requests/minute/org.
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
  const { count: recentCount } = await admin
    .from('worker_executions')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .gte('created_at', oneMinuteAgo)

  if ((recentCount ?? 0) >= RATE_LIMIT_RPM) {
    return new Response(
      'Rate limit exceeded. Please wait a moment before sending another message.',
      { status: 429 }
    )
  }

  // ─── P2-12: Load Conversation History (most recent N messages) ────────────
  // Fetch BEFORE saving current user message so we don't need to slice it out.
  // Sort descending then reverse to get correct chronological order for context.
  // Limit matches MAX_HISTORY_MESSAGES in orchestrator (both = 50).

  let conversationHistory: Array<{
    role: 'user' | 'assistant'
    content: string
  }> = []

  if (existingConversationId) {
    const { data: historyMessages } = await admin
      .from('messages')
      .select('role, content')
      .eq('conversation_id', existingConversationId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false }) // Newest first
      .limit(HISTORY_FETCH_LIMIT)

    if (historyMessages && historyMessages.length > 0) {
      conversationHistory = historyMessages
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            (m.role === 'user' || m.role === 'assistant') && !!m.content
        )
        .reverse() // Back to chronological order for the prompt builder
    }
  }

  // ─── Create or Get Conversation ───────────────────────────────────────────

  let conversationId = existingConversationId
  if (!conversationId) {
    const { data: conversation } = await admin
      .from('conversations')
      .insert({
        org_id: orgId,
        user_id: user.id,
        title: message.slice(0, 100),
        status: 'active',
      })
      .select('id')
      .single()

    conversationId = conversation?.id
  }

  if (!conversationId) {
    return new Response('Failed to create conversation', { status: 500 })
  }

  // ─── Save User Message ────────────────────────────────────────────────────

  await admin.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: message,
    parts: [{ id: crypto.randomUUID(), type: 'text', content: message, timestamp: Date.now() }] as unknown as Json,
  })

  // ─── AbortController ──────────────────────────────────────────────────────
  // Propagate request cancellation to the agent via AbortController.
  // When the client disconnects (closes SSE connection), the agent
  // will be aborted and resources cleaned up.

  const abortController = new AbortController()

  if (request.signal) {
    request.signal.addEventListener('abort', () => {
      abortController.abort()
    })
  }

  // ─── SSE Stream ───────────────────────────────────────────────────────────

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let fullResponse = ''
      let doneHandled = false
      const assembledParts: MessagePart[] = []

      // Helper to send SSE event
      const sendEvent = (event: StreamEvent) => {
        try {
          const sseData = JSON.stringify(event)
          controller.enqueue(encoder.encode(`data: ${sseData}\n\n`))
        } catch {
          // Controller may be closed
        }
      }

      try {
        const sdkInfo = getSDKInfo(orgSdkOverride)
        console.log(`[chat] Using SDK: ${sdkInfo.sdk} (model: ${sdkInfo.model}, provider: ${sdkInfo.provider})${orgSdkOverride ? ' [org override]' : ''}`)

        // Collect raw tool output data for entity extraction enrichment
        const toolOutputs: Array<{ toolName: string; output: string }> = []
        // Capture injected entity IDs for 'cited' utility tracking in extraction
        let injectedEntityIds: string[] = []
        const INTEGRATION_TOOLS = new Set([
          'read_recent_emails', 'search_emails', 'read_email',
          'get_today_events', 'get_upcoming_events',
          'read_slack_channel', 'get_slack_mentions',
          'get_compliance_overview', 'get_compliance_controls',
          'query_commitments',
        ])

        const agentStream = runCaptainWithSDK({
          orgId,
          userId: user.id,
          message,
          conversationId: conversationId!,
          sessionId: existingSessionId,
          abortController,
          conversationHistory,
          // Direct SSE emission callback — used by hooks to emit
          // approval_required and integration_required events while
          // the generator's for-await loop is blocked.
          onEmitEvent: (event: StreamEvent) => {
            try {
              const sseData = JSON.stringify(event)
              controller.enqueue(encoder.encode(`data: ${sseData}\n\n`))
              // Also accumulate for DB persistence — events emitted via
              // onEmitEvent bypass the generator loop, so without this
              // they'd appear during streaming but vanish on page reload.
              accumulatePart(event, assembledParts)
            } catch {
              // Controller may be closed
            }
          },
          // Capture raw tool output from integration tools for extraction enrichment
          onToolOutput: (toolName: string, output: string) => {
            if (INTEGRATION_TOOLS.has(toolName)) {
              toolOutputs.push({ toolName, output })
            }
          },
        }, orgSdkOverride)

        for await (const event of agentStream) {
          // Check if aborted
          if (abortController.signal.aborted) {
            break
          }

          // Send the event to client
          sendEvent(event)

          // Accumulate text for DB storage
          if (event.type === 'text' && event.content) {
            fullResponse += event.content
          }

          // Capture injected entity IDs from context pack for 'cited' tracking
          if (event.type === 'status' && event.injectedEntityIds) {
            injectedEntityIds = event.injectedEntityIds
          }

          // Accumulate parts for rich DB storage (agentic UI reload)
          accumulatePart(event, assembledParts)

          // Handle completion — guard against duplicate done events from orchestrator
          if (event.type === 'done' && !doneHandled) {
            doneHandled = true
            // Save assistant message with full metadata and parts for agentic UI reload
            await admin.from('messages').insert({
              conversation_id: conversationId,
              role: 'assistant',
              content: fullResponse,
              parts: assembledParts.length > 0 ? (assembledParts as unknown as Json) : null,
              metadata: {
                usage: event.usage,
                cost_usd: event.costUsd,
                duration_ms: event.durationMs,
                num_turns: event.numTurns,
                model_usage: event.modelUsage,
                session_id: event.sessionId,
              },
            })

            // Update conversation with session_id for resume
            if (event.sessionId) {
              await admin
                .from('conversations')
                .update({
                  session_id: event.sessionId,
                  metadata: {
                    last_usage: event.usage,
                    last_cost_usd: event.costUsd,
                  },
                })
                .eq('id', conversationId)
            }

            // Fire-and-forget: extract entities/relationships from both messages
            // Uses waitUntil() to keep the function alive after response is sent.
            // The assistant extraction is enriched with raw tool output data from
            // integration tools (emails, calendar, Slack, etc.) for richer entities.
            if (isOpenAIConfigured()) {
              waitUntil(
                Promise.all([
                  runExtractionPipeline({
                    orgId,
                    conversationId: conversationId!,
                    messageContent: message,
                    role: 'user',
                  }),
                  runExtractionPipeline({
                    orgId,
                    conversationId: conversationId!,
                    messageContent: fullResponse,
                    role: 'assistant',
                    toolOutputs: toolOutputs.length > 0 ? toolOutputs : undefined,
                    injectedEntityIds: injectedEntityIds.length > 0 ? injectedEntityIds : undefined,
                  }),
                ]).catch(err => console.error('[Extraction] Background failed:', err))
              )
            }

            // Send final done event with conversation ID
            sendEvent({
              type: 'done',
              conversationId,
              sessionId: event.sessionId,
              usage: event.usage,
              costUsd: event.costUsd,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
            })
          }

          // Handle errors — log details server-side, send generic message to client
          if (event.type === 'error') {
            console.error(`[Chat API] Agent error for conversation ${conversationId}:`, event.content)
            await admin.from('messages').insert({
              conversation_id: conversationId,
              role: 'system',
              content: `Agent encountered an error`,
            })
          }
        }
      } catch (error) {
        // ─── P1-8: Sanitize error messages ──────────────────────────────────
        // Log full error server-side (for debugging) but only send a generic
        // message to the client (avoids leaking stack traces / internal paths).
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error'

        // Don't log abort errors as unexpected
        if (errorMsg.includes('abort') || abortController.signal.aborted) {
          console.log(
            `[Chat API] Request aborted for conversation ${conversationId}`
          )
        } else {
          console.error(`[Chat API] Error for conversation ${conversationId}:`, errorMsg)
          // Generic client message — no internal details
          sendEvent({ type: 'error', content: 'An error occurred while processing your request.' })
        }

        // Save partial response if we have any
        if (fullResponse) {
          await admin.from('messages').insert({
            conversation_id: conversationId,
            role: 'assistant',
            content: fullResponse,
            parts: assembledParts.length > 0 ? (assembledParts as unknown as Json) : null,
            metadata: { partial: true },
          })
        }
      } finally {
        controller.close()
      }
    },

    cancel() {
      // Client disconnected — abort the agent and cleanup pending approvals
      abortController.abort()
      if (conversationId) {
        // Fire-and-forget: async cleanup is acceptable in cancel()
        cleanupConversationApprovals(conversationId).catch((err) => {
          console.error('[Chat API] Failed to cleanup approvals:', err)
        })
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  })
}
