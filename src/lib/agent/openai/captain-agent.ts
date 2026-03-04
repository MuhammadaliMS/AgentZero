/**
 * OpenAI Agents SDK — Captain Agent
 *
 * Full Captain agent implementation using the OpenAI Agents SDK (`@openai/agents`).
 * Mirrors the Claude SDK Captain in `orchestrator.ts` — same interfaces, same
 * permission system, same streaming behavior.
 *
 * Key differences from Claude SDK:
 * - Uses `Agent` + `Runner` classes instead of `query()`
 * - Tools return plain strings instead of MCP content arrays
 * - Permission gating is handled inside tool wrappers (not SDK hooks)
 * - Streaming via `runner.run(agent, prompt, { stream: true })` with
 *   real-time text deltas, tool events, and handoff events
 */

import { Agent, Runner } from '@openai/agents'
import type { RunStreamEvent, RunItemStreamEvent } from '@openai/agents'
import { OpenAIProvider, setOpenAIAPI } from '@openai/agents'
import { buildAgentContext } from '../context-builder'
import { buildAssociativeContext } from '@/lib/graph/associative-recall'
import { logWorkerExecution, completeWorkerExecution } from '../hooks'
import { cleanupConversationApprovals } from '../approval-store'
import { createCaptainTools, type CaptainToolParams } from './captain-tools'
import { createCaptainHandoffs } from './captain-workers'
import type { RunCaptainParams, StreamEvent } from '../orchestrator'
import { trackUtilityEventBatch, bumpEntityAccess } from '@/lib/graph/utility-tracker'

// ─── Model Configuration ─────────────────────────────────────────────────────
// Uses OPENAI_CAPTAIN_MODEL env var, or falls back to a sensible default.
// Routed via OpenRouter (OPENROUTER_API_KEY) or direct OpenAI (OPENAI_API_KEY).

const DEFAULT_CAPTAIN_MODEL = 'x-ai/grok-4.1-fast'
const CAPTAIN_MODEL = process.env.OPENAI_CAPTAIN_MODEL || DEFAULT_CAPTAIN_MODEL

// ─── OpenRouter / OpenAI Provider ────────────────────────────────────────────

function getCaptainProvider(): OpenAIProvider {
  const openRouterKey = process.env.OPENROUTER_API_KEY
  if (openRouterKey) {
    return new OpenAIProvider({
      apiKey: openRouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      useResponses: false, // OpenRouter only supports chat completions
    })
  }

  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    return new OpenAIProvider({
      apiKey: openaiKey,
      useResponses: false,
    })
  }

  throw new Error(
    'OpenAI Captain requires OPENROUTER_API_KEY or OPENAI_API_KEY to be configured.'
  )
}

// ─── Conversation History → Prompt Builder ──────────────────────────────────
// Same logic as orchestrator.ts — prepends history as XML context to the prompt.

const MAX_HISTORY_MESSAGES = 50
const MAX_HISTORY_CHARS = 12_000

function sanitizeHistoryContent(content: string): string {
  return content
    .replace(/<\s*\/?\s*conversation_history\s*>/gi, '[conversation_history]')
    .replace(/<\s*\/?\s*(system|instructions?|prompt|tool_result|function_call)\s*>/gi, '[$1]')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function buildPromptWithHistory(
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  currentMessage: string
): string {
  if (!conversationHistory || conversationHistory.length === 0) {
    return currentMessage
  }

  const recentHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES)
  let totalChars = 0
  const formattedMessages: string[] = []

  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const msg = recentHistory[i]
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant'
    const safeContent = sanitizeHistoryContent(msg.content)
    const formatted = `${roleLabel}: ${safeContent}`

    if (totalChars + formatted.length > MAX_HISTORY_CHARS) break
    totalChars += formatted.length
    formattedMessages.unshift(formatted)
  }

  if (formattedMessages.length === 0) return currentMessage

  return `<conversation_history>
The following is our conversation so far. Use this context to maintain continuity, avoid repeating information, and resolve references to prior messages.

${formattedMessages.join('\n\n')}
</conversation_history>

${currentMessage}`
}

// ─── Stream Event Helpers ────────────────────────────────────────────────────

/** Result from parsing a raw model stream event — can be text, reasoning, or nothing. */
type StreamDelta =
  | { kind: 'text'; content: string }
  | { kind: 'reasoning'; content: string }
  | null

/**
 * Extract text or reasoning delta from a raw model stream event.
 *
 * The SDK's streaming converter yields events with these types:
 *   - { type: 'model', event: <raw OpenRouter chunk> } — raw chat completion chunks
 *   - { type: 'output_text_delta', delta: '...' } — text deltas (already extracted by SDK)
 *
 * Grok via OpenRouter returns reasoning in `delta.reasoning_details` array:
 *   { type: "reasoning.summary", summary: "token text", format: "xai-responses-v1" }
 *
 * Some models return reasoning as `delta.reasoning` (string) — we handle both.
 */
function extractStreamDelta(rawEvent: unknown): StreamDelta {
  const event = rawEvent as Record<string, unknown>

  // ── Text deltas (SDK's converter output) ──────────────────────────
  if (event.type === 'output_text_delta') {
    const delta = (event as { delta?: string }).delta
    if (typeof delta === 'string') return { kind: 'text', content: delta }
  }

  // ── Raw model chunks (contains reasoning_details for Grok) ────────
  if (event.type === 'model') {
    const rawChunk = event.event as Record<string, unknown> | undefined
    const choices = rawChunk?.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    if (!delta) return null

    // Format 1: Grok via OpenRouter — reasoning_details array
    // Each entry: { type: "reasoning.summary"|"reasoning.text", summary: "...", text: "..." }
    const details = delta.reasoning_details as Array<Record<string, unknown>> | undefined
    if (Array.isArray(details) && details.length > 0) {
      const part = details[0]
      // Grok uses "summary" field, other models may use "text"
      const text = (part?.summary ?? part?.text) as string | undefined
      if (typeof text === 'string' && text) {
        return { kind: 'reasoning', content: text }
      }
    }

    // Format 2: Direct reasoning string (e.g., DeepSeek via Groq)
    if (typeof delta.reasoning === 'string' && delta.reasoning) {
      return { kind: 'reasoning', content: delta.reasoning }
    }
  }

  return null
}

/** Extract tool name from a RunItemStreamEvent */
function extractToolName(event: RunItemStreamEvent): string | null {
  const raw = event.item?.rawItem as Record<string, unknown> | undefined
  if (!raw) return null

  // Function call item has name field
  if (raw.type === 'function_call' && typeof raw.name === 'string') {
    return raw.name
  }

  // Function call output has call_id, but we need the name from the tool
  if (raw.type === 'function_call_output') {
    // The item itself might have the function name
    const item = event.item as unknown as { agent?: { name?: string } }
    return item?.agent?.name ?? null
  }

  return null
}

// ─── Main Agent Entry Point ──────────────────────────────────────────────────

/**
 * Run the Captain agent using the OpenAI Agents SDK and yield stream events.
 *
 * Designed to be a drop-in replacement for the Claude SDK's `runCaptain()` —
 * same `RunCaptainParams` input, same `AsyncGenerator<StreamEvent>` output.
 *
 * Uses streaming mode (`stream: true`) for real-time text deltas, tool events,
 * and agent handoff events — matching Claude SDK's step-by-step behavior.
 */
export async function* runOpenAICaptain(
  params: RunCaptainParams
): AsyncGenerator<StreamEvent> {
  const { orgId, userId, message } = params
  const startTime = Date.now()

  // Force chat completions API (OpenRouter doesn't support responses API)
  setOpenAIAPI('chat_completions')

  // Log execution start
  const executionId = await logWorkerExecution({
    org_id: orgId,
    conversation_id: params.conversationId,
    worker: 'captain-openai',
    trigger: 'chat',
    input_summary: message.slice(0, 200),
    status: 'running',
  })

  try {
    console.log(`[runOpenAICaptain] Starting for org=${orgId} model=${CAPTAIN_MODEL} provider=${process.env.OPENROUTER_API_KEY ? 'openrouter' : 'openai'}`)

    // Build context: loads profile, connected integrations, dynamic system prompt
    const context = await buildAgentContext(orgId, userId)

    // Inject associative recall context from knowledge graph
    const assocCtx = await buildAssociativeContext(orgId, message).catch(() => null)
    if (assocCtx?.contextBlock) {
      context.systemPrompt += assocCtx.contextBlock
      yield {
        type: 'status',
        content: `Knowledge graph: ${assocCtx.itemCount} items injected (${assocCtx.durationMs}ms)`,
        injectedEntityIds: assocCtx.matchedEntityIds,
      } as StreamEvent

      // Track 'injected' utility events and bump access for matched entities
      if (assocCtx.matchedEntityIds.length > 0) {
        trackUtilityEventBatch(orgId, assocCtx.matchedEntityIds, 'injected').catch(() => {})
        bumpEntityAccess(orgId, assocCtx.matchedEntityIds).catch(() => {})
      }
    }

    // Build tool params — events emitted directly via onEmitEvent for blocking events
    const toolParams: CaptainToolParams = {
      orgId,
      userId,
      conversationId: params.conversationId,
      connectedIntegrations: [...context.connectedIntegrations], // Mutable copy
      onEmitEvent: (event: StreamEvent) => {
        // For blocking events (approval_required, integration_required),
        // use the direct SSE callback if available (same as Claude SDK)
        if (
          event.type === 'approval_required' ||
          event.type === 'integration_required'
        ) {
          params.onEmitEvent?.(event)
        }
        // Non-blocking tool events (tool_call, tool_result) will now be
        // emitted from the stream loop below instead of being queued.
      },
      onToolOutput: params.onToolOutput,
    }

    // Create all 33 tools
    const tools = createCaptainTools(toolParams)

    // Create specialist sub-agent handoffs (Eve, Cole, Rhea)
    const handoffs = createCaptainHandoffs(toolParams)

    // Build prompt with conversation history
    const prompt = buildPromptWithHistory(params.conversationHistory, message)

    // Create the Agent with handoffs to specialists
    // Enable reasoning so the model "thinks" before acting — similar to Claude's extended thinking.
    // 'medium' gives the model solid thinking capacity to plan tool sequences,
    // synthesize multi-source data, and produce detailed explanations.
    const agent = Agent.create({
      name: 'Captain',
      instructions: context.systemPrompt,
      model: CAPTAIN_MODEL,
      modelSettings: {
        reasoning: {
          effort: 'medium',
        },
      },
      tools,
      handoffs,
    })

    // Create the Runner with model provider
    const runner = new Runner({
      modelProvider: getCaptainProvider(),
    })

    // Emit status event
    yield {
      type: 'status',
      content: 'Thinking...',
    }

    // ─── Run the Agent (Streaming Mode) ──────────────────────────────────
    // Stream events arrive in real-time:
    // - raw_model_stream_event → text deltas (streamed to client)
    // - run_item_stream_event → tool calls, tool outputs, handoffs
    // - agent_updated_stream_event → agent switches (handoffs)

    const streamResult = await runner.run(agent, prompt, {
      stream: true,
      maxTurns: 30,
      signal: params.abortController?.signal,
    })

    let fullText = ''
    let numTurns = 0
    const seenToolCalls = new Set<string>()

    for await (const streamEvent of streamResult) {
      // Check abort
      if (params.abortController?.signal.aborted) break

      switch (streamEvent.type) {
        // ─── Raw model text/reasoning deltas ─────────────────────────
        case 'raw_model_stream_event': {
          const delta = extractStreamDelta(streamEvent.data)
          if (delta) {
            if (delta.kind === 'text') {
              fullText += delta.content
              yield { type: 'text', content: delta.content }
            } else if (delta.kind === 'reasoning') {
              // Emit thinking events — matches Claude SDK's extended thinking behavior
              yield { type: 'thinking', content: delta.content }
            }
          }
          break
        }

        // ─── Run item events (tools, handoffs) ────────────────────────
        case 'run_item_stream_event': {
          const itemEvent = streamEvent as RunItemStreamEvent

          switch (itemEvent.name) {
            case 'tool_called': {
              const toolName = extractToolName(itemEvent) ?? 'unknown_tool'
              // Avoid duplicates for same tool call
              const callId = `${toolName}-${Date.now()}`
              if (!seenToolCalls.has(callId)) {
                seenToolCalls.add(callId)
                yield {
                  type: 'tool_use',
                  toolName,
                  content: `Calling ${toolName}...`,
                }
              }
              break
            }

            case 'tool_output': {
              const toolName = extractToolName(itemEvent) ?? 'tool'
              const rawItem = itemEvent.item?.rawItem as Record<string, unknown> | undefined
              const output = typeof rawItem?.output === 'string'
                ? rawItem.output
                : JSON.stringify(rawItem?.output ?? '')
              yield {
                type: 'tool_result',
                toolName,
                content: output.slice(0, 500),
              }
              break
            }

            case 'handoff_requested': {
              const agentName = (itemEvent.item as unknown as { rawItem?: { name?: string } })?.rawItem?.name
              yield {
                type: 'subagent_start',
                agentId: agentName ?? 'specialist',
                content: `Delegating to specialist: ${agentName ?? 'specialist'}`,
              }
              break
            }

            case 'handoff_occurred': {
              numTurns++
              break
            }

            case 'message_output_created': {
              // Final message output — text is already streamed via raw events
              // Just track the turn
              numTurns++
              break
            }

            case 'reasoning_item_created': {
              // Extract reasoning text from the completed reasoning item
              const reasoningItem = itemEvent.item?.rawItem as Record<string, unknown> | undefined
              const rawContent = reasoningItem?.rawContent as Array<Record<string, unknown>> | undefined
              if (rawContent) {
                for (const part of rawContent) {
                  if (part.type === 'reasoning_text' && typeof part.text === 'string' && part.text) {
                    yield { type: 'thinking', content: part.text }
                  }
                }
              }
              break
            }

            default:
              // tool_approval_requested, etc.
              break
          }
          break
        }

        // ─── Agent updated (handoff) ──────────────────────────────────
        case 'agent_updated_stream_event': {
          const newAgent = streamEvent.agent
          if (newAgent?.name && newAgent.name !== 'Captain') {
            yield {
              type: 'status',
              content: `${newAgent.name} is working...`,
            }
          }
          break
        }
      }
    }

    // Wait for completion and check for errors
    await streamResult.completed
    if (streamResult.error) {
      throw streamResult.error
    }

    // If no text was streamed (e.g., final output was in a non-delta format),
    // extract from the final result
    if (!fullText) {
      const finalOutput = streamResult.finalOutput
      fullText = typeof finalOutput === 'string'
        ? finalOutput
        : JSON.stringify(finalOutput ?? '')
      if (fullText) {
        yield {
          type: 'text',
          content: fullText,
        }
      }
    }

    // Estimate cost (Grok 4.1 Fast: $0.20/M input, $0.50/M output)
    const durationMs = Date.now() - startTime
    const totalUsage = {
      input_tokens: 0,
      output_tokens: 0,
    }
    const costUsd =
      (totalUsage.input_tokens * 0.0000002) +
      (totalUsage.output_tokens * 0.0000005)

    // Yield done event
    yield {
      type: 'done',
      usage: totalUsage,
      costUsd,
      durationMs,
      numTurns,
    }

    // Log completion
    if (executionId) {
      await completeWorkerExecution(executionId, {
        output_summary: fullText.slice(0, 300) || '[NO TEXT]',
        status: 'completed',
        duration_ms: durationMs,
        tokens_used: {
          input: totalUsage.input_tokens,
          output: totalUsage.output_tokens,
        },
        cost_usd: costUsd,
      })
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    // Extract HTTP status and API error details if available (OpenAI SDK errors)
    const errorStatus = (error as { status?: number }).status
    const errorBody = (error as { error?: unknown }).error

    if (executionId) {
      await completeWorkerExecution(executionId, {
        status: 'failed',
        duration_ms: Date.now() - startTime,
        error: errorMessage,
      })
    }

    const isAbort =
      errorMessage.includes('abort') ||
      errorMessage.includes('cancel') ||
      params.abortController?.signal.aborted
    if (!isAbort) {
      console.error(`[runOpenAICaptain] Error for org=${orgId}:`, errorMessage)
      if (errorStatus) console.error(`[runOpenAICaptain] HTTP status:`, errorStatus)
      if (errorBody) console.error(`[runOpenAICaptain] API error body:`, JSON.stringify(errorBody))
      console.error(`[runOpenAICaptain] Full error:`, error)
    }

    yield {
      type: 'error',
      content: isAbort
        ? 'Request cancelled.'
        : `An error occurred while processing your request.${errorStatus ? ` (${errorStatus})` : ''}`,
    }
  } finally {
    // Cleanup pending approvals on exit (fire-and-forget)
    cleanupConversationApprovals(params.conversationId).catch(() => {})
  }
}
