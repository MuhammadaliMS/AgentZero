import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'

import type { Database } from '@/types/database'
type OrgIntegration = Database['public']['Tables']['organization_integrations']['Row']

interface OrgIntegrationWithJoin extends OrgIntegration {
  integrations: { key: string; name: string; category: string }
}

export function createIntegrationTools(orgId: string) {
  const supabase = createAdminClient()

  const listConnectedIntegrations = tool(
    'list_connected_integrations',
    'List all integrations currently connected for this organization, including their health status.',
    {},
    async () => {
      const { data, error } = await supabase
        .from('organization_integrations')
        .select('*, integrations!inner(key, name, category)')
        .eq('org_id', orgId)
        .eq('is_active', true)

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }

      const rows = (data || []) as unknown as OrgIntegrationWithJoin[]
      const summary = rows.map(oi => ({
        key: oi.integrations.key,
        name: oi.integrations.name,
        category: oi.integrations.category,
        health_status: oi.health_status,
        connected_at: oi.created_at,
        user_metadata: oi.user_metadata,
      }))

      return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] }
    },
    { annotations: { title: 'List Connected Integrations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  const getIntegrationHealth = tool(
    'get_integration_health',
    'Check the health status of a specific connected integration.',
    {
      integration_key: z.string().describe('Integration key (e.g., slack, gmail, vanta)'),
    },
    async (args) => {
      const { data, error } = await supabase
        .from('organization_integrations')
        .select('*, integrations!inner(key, name)')
        .eq('org_id', orgId)
        .eq('integrations.key', args.integration_key)
        .single()

      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] }

      const row = data as unknown as OrgIntegrationWithJoin
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            key: row.integrations.key,
            name: row.integrations.name,
            is_active: row.is_active,
            health_status: row.health_status,
            failure_error: row.failure_error,
            last_health_check: row.last_health_check,
          }, null, 2),
        }],
      }
    },
    { annotations: { title: 'Get Integration Health', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  return [listConnectedIntegrations, getIntegrationHealth]
}
