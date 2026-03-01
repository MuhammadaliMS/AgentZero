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

  // Load profile and connected integrations in parallel
  const [profileResult, integrationsResult] = await Promise.all([
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
    buildUserContext(profile)

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
