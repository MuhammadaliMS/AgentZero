/**
 * SDK Switch — Runtime dispatcher between Claude Agent SDK and OpenAI Agents SDK.
 *
 * Controls which agent framework handles Captain requests.
 *
 * Configuration:
 *   AGENT_SDK=claude    → Use Claude Agent SDK (default)
 *   AGENT_SDK=openai    → Use OpenAI Agents SDK
 *
 * Both implementations share the same interfaces (RunCaptainParams, StreamEvent)
 * so the chat API route and frontend need zero changes.
 */

import type { RunCaptainParams, StreamEvent } from './orchestrator'

export type AgentSDK = 'claude' | 'openai'

/**
 * Get the currently configured agent SDK.
 */
export function getActiveSDK(): AgentSDK {
  const sdk = (process.env.AGENT_SDK || 'claude').toLowerCase().trim()
  if (sdk === 'openai') return 'openai'
  return 'claude' // Default
}

/**
 * Run the Captain agent using the configured SDK.
 * Drop-in replacement for the direct import of `runCaptain` from orchestrator.ts.
 *
 * Usage in API route:
 *   import { runCaptainWithSDK } from '@/lib/agent/sdk-switch'
 *   const stream = runCaptainWithSDK(params)
 *   for await (const event of stream) { ... }
 */
export async function* runCaptainWithSDK(
  params: RunCaptainParams
): AsyncGenerator<StreamEvent> {
  const sdk = getActiveSDK()

  if (sdk === 'openai') {
    // Dynamic import to avoid loading OpenAI SDK when using Claude
    const { runOpenAICaptain } = await import('./openai/captain-agent')
    yield* runOpenAICaptain(params)
  } else {
    // Dynamic import to avoid circular dependency issues
    const { runCaptain } = await import('./orchestrator')
    yield* runCaptain(params)
  }
}

/**
 * Get metadata about the active SDK for debugging/logging.
 */
export function getSDKInfo(): {
  sdk: AgentSDK
  model: string
  provider: string
} {
  const sdk = getActiveSDK()

  if (sdk === 'openai') {
    const model = process.env.OPENAI_CAPTAIN_MODEL || 'openai/gpt-4.1-mini'
    const provider = process.env.OPENROUTER_API_KEY ? 'openrouter' : 'openai'
    return { sdk, model, provider }
  }

  const model = process.env.CAPTAIN_MODEL || 'claude-haiku-4-5-20251001'
  const provider = process.env.ANTHROPIC_BASE_URL?.includes('openrouter')
    ? 'openrouter'
    : 'anthropic'
  return { sdk, model, provider }
}
