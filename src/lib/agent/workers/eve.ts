import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { EVE_PROMPT } from '../prompts/eve-prompt'

/**
 * Eve — Strategy Analyst
 *
 * Specializes in board narratives, QBR preparation, executive communications,
 * and stakeholder management. Delegated to when the user asks about:
 * board prep, executive emails, QBR content, strategic narratives,
 * stakeholder updates, risk communication, or C-suite talking points.
 *
 * SDK AgentDefinition features used:
 * - tools: Explicitly lists allowed tools (principle of least privilege)
 * - disallowedTools: Prevents use of operational tools outside Eve's domain
 * - model: sonnet for fast, capable analysis
 * - maxTurns: Capped at 15 to prevent runaway execution
 * - criticalSystemReminder_EXPERIMENTAL: Reinforces role boundaries
 */
export const eveAgent: AgentDefinition = {
  description:
    'Strategy Analyst for board narratives, QBR preparation, executive communications, and stakeholder management. Delegate to Eve when the user asks about: board prep, executive emails, QBR content, strategic narratives, stakeholder updates, risk communication, or C-suite talking points.',

  prompt: EVE_PROMPT,

  model: 'sonnet',

  // Allowed tools — strategy analysis + read-only built-in tools
  tools: [
    // Built-in (read-only for research)
    'Read', 'Glob', 'Grep',
    // MCP tools
    'recall_memory',
    'store_memory',
    'update_memory',
    'query_commitments',
    'create_commitment',
    'read_recent_emails',
    'search_emails',
    'draft_email',
    'get_today_events',
    'get_week_events',
    'list_connected_integrations',
    // Slack read (context gathering for stakeholder analysis)
    'list_slack_channels',
    'read_slack_channel',
    'read_slack_thread',
    'read_slack_dms',
    'get_slack_mentions',
  ],

  // Explicitly disallow operational tools + write/script built-ins
  disallowedTools: [
    'Bash', 'Write',
    'send_slack_dm',
    'send_approval_message',
    'update_slack_message',
    'get_compliance_overview',
    'list_failing_controls',
    'get_audit_status',
    'resolve_action',
  ],

  maxTurns: 15,

  criticalSystemReminder_EXPERIMENTAL:
    'You are Eve, a Strategy Analyst. Focus exclusively on executive communications, board narratives, and strategic analysis. Do NOT attempt operational tasks like sending Slack messages or managing compliance controls. If asked about compliance or operations, recommend delegating to the appropriate specialist.',
}
