import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createVantaTools(orgId: string) {
  const getComplianceOverview = tool(
    'get_compliance_overview',
    'Get a high-level overview of the organization compliance posture from Vanta. Returns structured summary with control counts by status and framework breakdown.',
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
        const controls = data.results || data.data || []

        // ✅ Transform raw JSON into structured summary
        const summary = summarizeControls(controls)
        return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Get Compliance Overview', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const listFailingControls = tool(
    'list_failing_controls',
    'List all controls that are currently failing or need attention in Vanta. Returns structured list with control names, owners, and severity.',
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
        const allControls = data.results || data.data || []
        const failing = allControls.filter(
          (c: Record<string, unknown>) =>
            c.status === 'FAILING' || c.status === 'AT_RISK' ||
            c.status === 'DISABLED' || c.status === 'NEEDS_ATTENTION'
        )

        // ✅ Transform to structured, concise output
        const structured = failing.map((c: Record<string, unknown>) => ({
          name: c.name || c.controlName || c.title || 'Unknown',
          status: c.status,
          framework: c.frameworkId || c.framework || undefined,
          category: c.category || c.controlCategory || undefined,
          owner: c.owner || (c.assignee as { email?: string })?.email || undefined,
          description: c.description ? (c.description as string).slice(0, 200) : undefined,
          last_updated: c.updatedAt || c.lastUpdatedAt || undefined,
        }))

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total_failing: structured.length,
              total_controls: allControls.length,
              failing_controls: structured,
              ...(args.framework ? { filtered_by: args.framework } : {}),
            }, null, 2),
          }],
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'List Failing Controls', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const getAuditStatus = tool(
    'get_audit_status',
    'Get audit timeline and evidence collection status from Vanta. Returns structured summary of active audits, milestones, and readiness.',
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
        const audits = data.results || data.data || []

        // ✅ Transform to structured audit summary
        const structured = Array.isArray(audits) ? audits.map((a: Record<string, unknown>) => ({
          name: a.name || a.auditName || a.displayName || 'Unknown',
          framework: a.frameworkId || a.framework || undefined,
          status: a.status || a.auditStatus || undefined,
          start_date: a.startDate || a.auditStartDate || undefined,
          end_date: a.endDate || a.auditEndDate || undefined,
          auditor: a.auditorName || a.auditorFirm ||
            (a.auditor as { name?: string })?.name || undefined,
          evidence_progress: a.evidenceProgress || a.completionPercentage || undefined,
          outstanding_items: a.outstandingItems || a.openItems || undefined,
        })) : []

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total_audits: structured.length,
              audits: structured,
            }, null, 2),
          }],
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Vanta error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Get Audit Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [getComplianceOverview, listFailingControls, getAuditStatus]
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Summarize an array of Vanta controls into a structured overview.
 * Prevents raw JSON dumps that overflow context.
 */
function summarizeControls(controls: Array<Record<string, unknown>>) {
  const total = controls.length

  // Count by status
  const statusCounts: Record<string, number> = {}
  for (const c of controls) {
    const status = (c.status as string) || 'UNKNOWN'
    statusCounts[status] = (statusCounts[status] || 0) + 1
  }

  // Group by framework
  const frameworkCounts: Record<string, { total: number; passing: number; failing: number }> = {}
  for (const c of controls) {
    const fw = (c.frameworkId || c.framework || 'Unknown') as string
    if (!frameworkCounts[fw]) frameworkCounts[fw] = { total: 0, passing: 0, failing: 0 }
    frameworkCounts[fw].total++
    if (c.status === 'PASSING' || c.status === 'ACTIVE') {
      frameworkCounts[fw].passing++
    } else {
      frameworkCounts[fw].failing++
    }
  }

  // Top failing controls (max 10)
  const failingControls = controls
    .filter(c => c.status === 'FAILING' || c.status === 'AT_RISK' || c.status === 'NEEDS_ATTENTION')
    .slice(0, 10)
    .map(c => ({
      name: c.name || c.controlName || c.title || 'Unknown',
      status: c.status,
      category: c.category || c.controlCategory || undefined,
    }))

  const passing = (statusCounts['PASSING'] || 0) + (statusCounts['ACTIVE'] || 0)
  const healthScore = total > 0 ? Math.round((passing / total) * 100) : 0

  return {
    health_score: `${healthScore}%`,
    total_controls: total,
    status_breakdown: statusCounts,
    frameworks: frameworkCounts,
    top_failing: failingControls.length > 0 ? failingControls : 'None — all controls passing',
  }
}
