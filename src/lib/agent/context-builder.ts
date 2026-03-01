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
  const systemPrompt =
    CAPTAIN_BASE_PROMPT +
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
  return ['supabase', 'memory', 'integration', 'slack', 'email', 'calendar', 'vanta']
}

// ─── Graph Context Loader ────────────────────────────────────────────────
// Fetches the top active entities from the knowledge graph and appends
// a lightweight summary to the system prompt. This gives the agent
// awareness of the org's entity landscape at conversation start.

async function loadGraphContext(orgId: string): Promise<string> {
  try {
    const supabase = createAdminClient()

    // Fetch top 15 most recently active entities
    const { data: entities } = await supabase
      .from('entities')
      .select('name, entity_type, mention_count, last_seen_at')
      .eq('org_id', orgId)
      .order('last_seen_at', { ascending: false })
      .limit(15)

    if (!entities || entities.length === 0) return ''

    // Format as a compact section for the system prompt
    const entityList = entities
      .map(e => `${e.name} (${e.entity_type}, ${e.mention_count}x)`)
      .join(' · ')

    return `\n\n## Active Knowledge Graph\nKey entities tracked: ${entityList}\n\nUse \`query_entity_graph\` or \`get_entity_timeline\` to explore connections and history.`
  } catch {
    // Non-critical — don't block agent startup if graph query fails
    return ''
  }
}
