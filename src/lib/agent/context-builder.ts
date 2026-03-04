import { createAdminClient } from '@/lib/supabase/admin'
import {
  CAPTAIN_BASE_PROMPT,
  buildCapabilitiesSection,
  buildUserContext,
} from './prompts/captain'

export interface AgentContext {
  orgId: string
  userId: string
  profile: {
    full_name: string | null
    role: string | null
    title: string | null
    timezone: string | null
    communication_style: string | null
    email: string | null
  }
  connectedIntegrations: string[]
  systemPrompt: string
}

export async function buildAgentContext(orgId: string, userId: string): Promise<AgentContext> {
  const supabase = createAdminClient()

  // Load profile, connected integrations, and graph context in parallel
  const [profileResult, integrationsResult, graphContext] = await Promise.all([
    supabase
      .from('profiles')
      .select('full_name, role, title, timezone, communication_style, email')
      .eq('id', userId)
      .single(),
    supabase
      .from('organization_integrations')
      .select('integrations!inner(key)')
      .eq('org_id', orgId)
      .eq('is_active', true),
    loadGraphContext(orgId),
  ])

  const profile = profileResult.data || {
    full_name: null,
    role: null,
    title: null,
    timezone: null,
    communication_style: null,
    email: null,
  }

  const connectedIntegrations = (integrationsResult.data || []).map(
    (oi) => (oi.integrations as unknown as { key: string }).key
  )

  // Build the dynamic system prompt
  // Inject current date/time at the top of the prompt so the model always knows the time
  const currentDatetime = formatCurrentDatetime(profile.timezone)
  const basePromptWithTime = CAPTAIN_BASE_PROMPT.replace('{{CURRENT_DATETIME}}', currentDatetime)

  const systemPrompt =
    basePromptWithTime +
    buildCapabilitiesSection(connectedIntegrations) +
    buildUserContext(profile) +
    graphContext

  return {
    orgId,
    userId,
    profile,
    connectedIntegrations,
    systemPrompt,
  }
}

/**
 * Determine which tool sets to load based on connected integrations
 */
export function getRequiredToolSets(_connectedIntegrations: string[]): string[] {
  // Always load ALL tool sets so the agent can attempt any tool.
  // canUseTool intercepts calls to unconnected integrations and emits
  // an integration_required event, showing the inline connect card.
  return ['supabase', 'memory', 'integration', 'slack', 'email', 'calendar', 'vanta', 'outcome']
}

// ─── Graph Context Loader ────────────────────────────────────────────────
// Fetches the top active entities from the knowledge graph and appends
// a lightweight summary to the system prompt. This gives the agent
// awareness of the org's entity landscape at conversation start.

async function loadGraphContext(orgId: string): Promise<string> {
  try {
    const supabase = createAdminClient()

    // Use decay-aware relevance scoring (per-class half-lives)
    const { data: entities } = await supabase.rpc('get_relevant_entities', {
      p_org_id: orgId,
      p_limit: 20,
      p_min_relevance: 0.1,
    })

    if (!entities || entities.length === 0) return ''

    // Format with relevance score and state
    const entityList = (entities as Array<{
      entity_name: string
      entity_type: string
      mention_count: number
      relevance_score: number
      entity_state: string
    }>)
      .map(e => `${e.entity_name} (${e.entity_type}, ${e.mention_count}x, rel:${e.relevance_score.toFixed(1)}${e.entity_state === 'pinned' ? ', pinned' : ''})`)
      .join(' · ')

    return `\n\n## Active Knowledge Graph\nKey entities tracked: ${entityList}\n\nUse \`query_entity_graph\` or \`get_entity_timeline\` to explore connections and history.`
  } catch {
    // Non-critical — don't block agent startup if graph query fails
    return ''
  }
}

// ─── Date/Time Formatter ────────────────────────────────────────────────────
// Formats a prominent date/time string for injection at the top of the system prompt.
// Uses the user's timezone if available, otherwise falls back to UTC.
// This ensures the model always knows the current date and time.

function formatCurrentDatetime(timezone: string | null | undefined): string {
  const now = new Date()
  try {
    const tz = timezone || 'UTC'
    const formatted = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
    // Also include ISO format for unambiguous machine-readable date
    const isoDate = now.toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD
    return `${formatted} (${tz}) — ISO: ${isoDate}`
  } catch {
    return `${now.toUTCString()} (UTC)`
  }
}
