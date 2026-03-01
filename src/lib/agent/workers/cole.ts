import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { COLE_PROMPT } from '../prompts/cole-prompt'

/**
 * Cole — Program Manager
 *
 * Specializes in commitment tracking, OKRs, accountability, action items,
 * and status reporting. Delegated to when the user asks about:
 * tracking commitments, deliverable status, deadline management,
 * action items, status reports, OKR health, meeting prep,
 * or cross-functional coordination.
 *
 * SDK AgentDefinition features used:
 * - tools: Full operational toolkit for PM work
 * - disallowedTools: Prevents use of compliance/strategy-specific tools
 * - model: sonnet for structured, reliable tracking
 * - maxTurns: 20 — PM tasks often require more tool interactions
 * - criticalSystemReminder_EXPERIMENTAL: Keeps Cole focused on PM duties
 */
export const coleAgent: AgentDefinition = {
  description:
    'Program Manager for commitment tracking, OKRs, accountability, action items, and status reporting. Delegate to Cole when the user asks about: tracking commitments, deliverable status, deadline management, action items, status reports, OKR health, meeting prep, or cross-functional coordination.',

  prompt: COLE_PROMPT,

  model: 'sonnet',

  // Allowed tools — full operational toolkit + all built-in tools for report generation
  tools: [
    // Built-in (full toolkit for writing reports/analysis)
    'Bash', 'Read', 'Write', 'Glob', 'Grep',
    // MCP tools
    'recall_memory',
    'store_memory',
    'update_memory',
    'query_commitments',
    'create_commitment',
    'update_commitment',
    'query_actions',
    'create_action',
    'resolve_action',
    'get_today_events',
    'get_week_events',
    'find_free_slots',
    'send_slack_dm',
    'send_approval_message',
    'list_connected_integrations',
    // Slack read (context gathering for PM coordination)
    'list_slack_channels',
    'read_slack_channel',
    'read_slack_thread',
    'read_slack_dms',
    'get_slack_mentions',
  ],

  // Explicitly disallow compliance and email tools outside Cole's domain
  disallowedTools: [
    'get_compliance_overview',
    'list_failing_controls',
    'get_audit_status',
    'read_recent_emails',
    'search_emails',
    'draft_email',
  ],

  maxTurns: 20,

  criticalSystemReminder_EXPERIMENTAL:
    'You are Cole, a Program Manager. Focus exclusively on commitment tracking, action items, status reporting, and coordination. Do NOT attempt compliance analysis or draft emails. If asked about compliance or executive communications, recommend delegating to the appropriate specialist.',
}
