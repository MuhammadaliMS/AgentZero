import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createVantaTools(orgId: string) {
  const getComplianceOverview = tool(
    'get_compliance_overview',
    'Get a high-level overview of the organization compliance posture from Vanta. Shows frameworks, control status, and overall health.',
    {},
    async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) {
        return buildIntegrationRequiredResult('vanta', 'Vanta')
      }

      try {
        const response = await fetch('https://api.vanta.com/v1/resources/controls', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return buildIntegrationRequiredResult('vanta', 'Vanta')
          }
          return { content: [{ type: 'text' as const, text: `Vanta API error: ${response.status}` }] }
        }

        const data = await response.json()
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Get Compliance Overview', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const listFailingControls = tool(
    'list_failing_controls',
    'List all controls that are currently failing or need attention in Vanta.',
    {
      framework: z.string().optional().describe('Filter by framework (e.g., SOC2, ISO27001)'),
    },
    async (args) => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) {
        return buildIntegrationRequiredResult('vanta', 'Vanta')
      }

      try {
        let url = 'https://api.vanta.com/v1/resources/controls'
        if (args.framework) {
          url += `?frameworkId=${args.framework}`
        }

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return buildIntegrationRequiredResult('vanta', 'Vanta')
          }
          return { content: [{ type: 'text' as const, text: `Vanta API error: ${response.status}` }] }
        }

        const data = await response.json()
        const failing = (data.results || data.data || []).filter(
          (c: Record<string, unknown>) => c.status === 'FAILING' || c.status === 'AT_RISK' || c.status === 'DISABLED'
        )

        return { content: [{ type: 'text' as const, text: JSON.stringify(failing, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'List Failing Controls', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const getAuditStatus = tool(
    'get_audit_status',
    'Get audit timeline and evidence collection status from Vanta.',
    {},
    async () => {
      const tokens = await TokenManager.getTokens(orgId, 'vanta')
      if (!tokens) {
        return buildIntegrationRequiredResult('vanta', 'Vanta')
      }

      try {
        const response = await fetch('https://api.vanta.com/v1/resources/audits', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return buildIntegrationRequiredResult('vanta', 'Vanta')
          }
          return { content: [{ type: 'text' as const, text: `Vanta API error: ${response.status}` }] }
        }

        const data = await response.json()
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Get Audit Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [getComplianceOverview, listFailingControls, getAuditStatus]
}
