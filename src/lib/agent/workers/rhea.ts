import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { RHEA_PROMPT } from '../prompts/rhea-prompt'

/**
 * Rhea — GRC Analyst
 *
 * Specializes in compliance frameworks, audit readiness, control monitoring,
 * risk assessment, and POAM tracking. Delegated to when the user asks about:
 * SOC2/ISO/HIPAA/PCI compliance, audit prep, control status,
 * compliance posture, vendor risk, evidence collection, POAM,
 * or remediation plans.
 *
 * SDK AgentDefinition features used:
 * - tools: Compliance-focused toolkit with Vanta integration
 * - disallowedTools: Prevents use of email/Slack/calendar tools
 * - model: sonnet for precise compliance analysis
 * - maxTurns: 15 — compliance queries are typically well-scoped
 * - criticalSystemReminder_EXPERIMENTAL: Keeps Rhea focused on GRC duties
 */
export const rheaAgent: AgentDefinition = {
  description:
    'GRC Analyst for compliance frameworks, audit readiness, control monitoring, risk assessment, and POAM tracking. Delegate to Rhea when the user asks about: SOC2/ISO/HIPAA/PCI compliance, audit prep, control status, compliance posture, vendor risk, evidence collection, POAM, or remediation plans.',

  prompt: RHEA_PROMPT,

  model: 'sonnet',

  // Allowed tools — compliance-focused toolkit + read/bash for analysis
  tools: [
    // Built-in (read + bash for data analysis, no write)
    'Bash', 'Read', 'Glob', 'Grep',
    // MCP tools
    'recall_memory',
    'store_memory',
    'update_memory',
    'query_commitments',
    'create_commitment',
    'update_commitment',
    'get_compliance_overview',
    'list_failing_controls',
    'get_audit_status',
    'query_actions',
    'create_action',
    'list_connected_integrations',
    'get_integration_health',
  ],

  // Explicitly disallow email, Slack, calendar, and file write tools
  disallowedTools: [
    'Write',
    'read_recent_emails',
    'search_emails',
    'draft_email',
    // Slack — all access blocked for GRC analyst
    'list_slack_channels',
    'read_slack_channel',
    'read_slack_thread',
    'read_slack_dms',
    'get_slack_mentions',
    'send_slack_dm',
    'send_approval_message',
    'update_slack_message',
    'get_today_events',
    'get_week_events',
    'find_free_slots',
  ],

  maxTurns: 15,

  criticalSystemReminder_EXPERIMENTAL:
    'You are Rhea, a GRC Analyst. Focus exclusively on compliance, audit readiness, control monitoring, and risk assessment. Do NOT attempt to send emails, Slack messages, or manage calendar events. If asked about scheduling or communications, recommend delegating to the appropriate specialist.',
}
