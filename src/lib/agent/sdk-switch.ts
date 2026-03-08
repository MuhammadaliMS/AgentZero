/**
 * SDK Switch — Runtime dispatcher between Claude Agent SDK and OpenAI Agents SDK.
 *
 * Controls which agent framework handles Captain requests.
 *
 * Priority (highest → lowest):
 *   1. Per-org override from DB (organizations.settings.agent_sdk)
 *   2. AGENT_SDK env var (claude | openai)
 *   3. Default: claude
 *
 * Both implementations share the same interfaces (RunCaptainParams, StreamEvent)
 * so the chat API route and frontend need zero changes.
 */

import type { RunCaptainParams, StreamEvent } from './orchestrator'

export type AgentSDK = 'claude' | 'openai'

/**
 * Get the currently configured agent SDK.
 * Accepts an optional override (e.g., from the org's DB settings).
 */
export function getActiveSDK(override?: AgentSDK): AgentSDK {
  // Per-org override takes priority
  if (override === 'openai') return 'openai'
  if (override === 'claude') return 'claude'

  // Fall back to env var
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
  params: RunCaptainParams,
  sdkOverride?: AgentSDK
): AsyncGenerator<StreamEvent> {
  const sdk = getActiveSDK(sdkOverride)

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
export function getSDKInfo(override?: AgentSDK): {
  sdk: AgentSDK
  model: string
  provider: string
} {
  const sdk = getActiveSDK(override)

  if (sdk === 'openai') {
    const model = process.env.OPENAI_CAPTAIN_MODEL || 'qwen/qwen3.5-397b-a17b'
    const provider = process.env.NVIDIA_API_KEY ? 'nvidia' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'openai'
    return { sdk, model, provider }
  }

  const model = process.env.CAPTAIN_MODEL || 'claude-haiku-4-5-20251001'
  const provider = process.env.ANTHROPIC_BASE_URL?.includes('openrouter')
    ? 'openrouter'
    : 'anthropic'
  return { sdk, model, provider }
}
