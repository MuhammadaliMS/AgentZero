// ─── Tool Metadata ──────────────────────────────────────────────────────
// Maps tool names to their required integrations, human-readable display
// names, and approval text builders.

// ─── Tool → Integration Mapping ─────────────────────────────────────────
// Maps each tool to the integration it requires to function.

interface IntegrationInfo {
  key: string
  name: string
}

const TOOL_TO_INTEGRATION: Record<string, IntegrationInfo> = {
  // Email tools → Gmail or Outlook
  read_recent_emails: { key: 'gmail', name: 'Gmail' },
  search_emails: { key: 'gmail', name: 'Gmail' },
  read_email: { key: 'gmail', name: 'Gmail' },
  draft_email: { key: 'gmail', name: 'Gmail' },
  send_email: { key: 'gmail', name: 'Gmail' },

  // Slack tools — read
  list_slack_channels: { key: 'slack', name: 'Slack' },
  read_slack_channel: { key: 'slack', name: 'Slack' },
  read_slack_thread: { key: 'slack', name: 'Slack' },
  read_slack_dms: { key: 'slack', name: 'Slack' },
  get_slack_mentions: { key: 'slack', name: 'Slack' },
  // Slack tools — write
  send_slack_dm: { key: 'slack', name: 'Slack' },
  post_to_channel: { key: 'slack', name: 'Slack' },
  send_approval_message: { key: 'slack', name: 'Slack' },
  update_slack_message: { key: 'slack', name: 'Slack' },

  // Calendar tools → Google Calendar
  get_today_events: { key: 'google_calendar', name: 'Google Calendar' },
  get_week_events: { key: 'google_calendar', name: 'Google Calendar' },
  find_free_slots: { key: 'google_calendar', name: 'Google Calendar' },

  // Compliance tools → Vanta
  get_compliance_overview: { key: 'vanta', name: 'Vanta' },
  list_failing_controls: { key: 'vanta', name: 'Vanta' },
  get_audit_status: { key: 'vanta', name: 'Vanta' },
}

/**
 * Get the integration required by a tool, or null if none required.
 */
export function getRequiredIntegration(toolName: string): IntegrationInfo | null {
  return TOOL_TO_INTEGRATION[toolName] || null
}

// ─── Integration-Required Tool Result Builder ───────────────────────────
// When a tool can't execute because its integration isn't connected,
// it returns this structured result. The PostToolUse hook detects the
// __INTEGRATION_REQUIRED__ marker and emits an SSE event so the frontend
// shows the "Connect [Integration]" card in the chat UI.
//
// The marker format is: __INTEGRATION_REQUIRED__:key:name
// e.g., __INTEGRATION_REQUIRED__:gmail:Gmail

/** Prefix used to identify integration-required tool results */
export const INTEGRATION_REQUIRED_MARKER = '__INTEGRATION_REQUIRED__'

/**
 * Build a structured tool result for when an integration is not connected.
 * Used by MCP tool execute functions to signal missing integrations.
 *
 * The PostToolUse hook parses the marker to emit integration_required SSE events.
 * The text after the marker instructs the agent not to explain the missing
 * integration verbally — the UI connect card handles user communication.
 */
export function buildIntegrationRequiredResult(integrationKey: string, integrationName: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `${INTEGRATION_REQUIRED_MARKER}:${integrationKey}:${integrationName} — A connection prompt has been shown in the UI. Do not explain the missing integration in text — simply acknowledge and move on to other tasks.`,
    }],
  }
}

/**
 * Parse an integration-required marker from a tool result text.
 * Returns { key, name } if the marker is found, null otherwise.
 *
 * Format: __INTEGRATION_REQUIRED__:key:name — description...
 * Uses regex for robust parsing instead of fragile split(':').
 */
export function parseIntegrationRequiredMarker(text: string): { key: string; name: string } | null {
  if (!text.startsWith(INTEGRATION_REQUIRED_MARKER)) return null

  // Regex: marker + ':' + key (lowercase alphanumeric, underscores, hyphens) + ':' + name (before ' — ')
  const match = text.match(
    /^__INTEGRATION_REQUIRED__:([a-z0-9_-]+):(.+?)(?:\s*—|$)/
  )
  if (!match) return null

  return {
    key: match[1],
    name: match[2].trim(),
  }
}

// ─── Tool Display Names ─────────────────────────────────────────────────
// Human-readable names shown in the chat UI.

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Email
  read_recent_emails: 'Reading Emails',
  search_emails: 'Searching Emails',
  read_email: 'Reading Email',
  draft_email: 'Drafting Email',
  send_email: 'Sending Email',

  // Slack — read
  list_slack_channels: 'Listing Slack Channels',
  read_slack_channel: 'Reading Slack Channel',
  read_slack_thread: 'Reading Slack Thread',
  read_slack_dms: 'Reading Slack DMs',
  get_slack_mentions: 'Checking Slack Mentions',
  // Slack — write
  send_slack_dm: 'Sending Slack Message',
  post_to_channel: 'Posting to Channel',
  send_approval_message: 'Posting Approval Request',
  update_slack_message: 'Updating Slack Message',

  // Calendar
  get_today_events: 'Checking Today\'s Calendar',
  get_week_events: 'Checking Weekly Calendar',
  find_free_slots: 'Finding Available Slots',

  // Compliance
  get_compliance_overview: 'Checking Compliance Posture',
  list_failing_controls: 'Reviewing Failing Controls',
  get_audit_status: 'Checking Audit Status',

  // Memory
  recall_memory: 'Recalling Context',
  store_memory: 'Storing Context',
  update_memory: 'Updating Context',

  // Supabase / CRUD
  query_commitments: 'Checking Commitments',
  create_commitment: 'Creating Commitment',
  update_commitment: 'Updating Commitment',
  query_actions: 'Checking Action Items',
  create_action: 'Creating Action Item',
  resolve_action: 'Resolving Action Item',

  // Integration
  list_connected_integrations: 'Checking Integrations',
  get_integration_health: 'Checking Integration Health',

  // Built-in SDK tools
  Bash: 'Running Script',
  Read: 'Reading File',
  Write: 'Writing File',
  Glob: 'Searching Files',
  Grep: 'Searching Content',
}

/**
 * Get a human-readable display name for a tool.
 * Falls back to formatting the tool_name with capitalization.
 */
export function formatToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) {
    return TOOL_DISPLAY_NAMES[toolName]
  }
  // Fallback: convert snake_case to Title Case
  return toolName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Approval Text Builders ─────────────────────────────────────────────
// Generate human-readable titles and descriptions for approval cards.

/**
 * Build a concise title for the approval card.
 */
export function buildApprovalTitle(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case 'send_slack_dm':
      return `Send Slack DM to ${input.recipient || input.user_id || input.user_email || 'user'}`
    case 'post_to_channel':
      return `Post message to Slack channel ${input.channel_id || 'unknown'}`
    case 'send_approval_message':
      return `Post approval request in ${input.channel || 'Slack'}`
    case 'draft_email':
      return `Draft email to ${input.to || 'recipient'}`
    case 'send_email':
      return `Send email to ${input.to || 'recipient'}`
    case 'update_slack_message':
      return `Update Slack message in ${input.channel || 'channel'}`
    case 'create_commitment':
      return `Create commitment: "${truncate(input.title as string, 50)}"`
    case 'create_action':
      return `Create action item: "${truncate(input.title as string, 50)}"`
    case 'resolve_action':
      return `Resolve action: ${input.action_id || input.id || 'unknown'}`
    case 'update_commitment':
      return `Update commitment: ${input.commitment_id || input.id || 'unknown'}`
    default:
      return `Execute ${formatToolDisplayName(toolName)}`
  }
}

/**
 * Build a detailed description of what the tool will do.
 */
export function buildApprovalDescription(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case 'send_slack_dm':
      return [
        `**To:** ${input.recipient || input.user_id || input.user_email || 'user'}`,
        `**Message:** "${truncate(input.message as string, 300)}"`,
      ].join('\n')

    case 'post_to_channel':
      return [
        `**Channel:** ${input.channel_id || 'unknown'}`,
        `**Message:** "${truncate(input.message as string, 300)}"`,
        input.thread_ts ? `**Thread:** ${input.thread_ts}` : '',
      ]
        .filter(Boolean)
        .join('\n')

    case 'send_approval_message':
      return [
        `**Channel:** ${input.channel || 'default'}`,
        `**Title:** ${input.title || 'Approval Request'}`,
        input.description
          ? `**Description:** "${truncate(input.description as string, 200)}"`
          : '',
      ]
        .filter(Boolean)
        .join('\n')

    case 'draft_email':
      return [
        `**To:** ${input.to || 'recipient'}`,
        `**Subject:** ${input.subject || '(no subject)'}`,
        `**Preview:** "${truncate(input.body as string, 300)}"`,
      ].join('\n')

    case 'send_email':
      return [
        `**To:** ${input.to || 'recipient'}`,
        `**Subject:** ${input.subject || '(no subject)'}`,
        `**Preview:** "${truncate(input.body as string, 300)}"`,
      ].join('\n')

    case 'update_slack_message':
      return [
        `**Channel:** ${input.channel || 'unknown'}`,
        `**Message TS:** ${input.ts || 'unknown'}`,
        `**New Text:** "${truncate(input.text as string, 300)}"`,
      ].join('\n')

    case 'create_commitment':
      return [
        `**Title:** ${input.title || 'Untitled'}`,
        input.due_date ? `**Due:** ${input.due_date}` : '',
        input.priority ? `**Priority:** ${input.priority}` : '',
        input.description
          ? `**Description:** "${truncate(input.description as string, 200)}"`
          : '',
      ]
        .filter(Boolean)
        .join('\n')

    case 'create_action':
      return [
        `**Title:** ${input.title || 'Untitled'}`,
        input.type ? `**Type:** ${input.type}` : '',
        input.priority ? `**Priority:** ${input.priority}` : '',
        input.description
          ? `**Description:** "${truncate(input.description as string, 200)}"`
          : '',
      ]
        .filter(Boolean)
        .join('\n')

    case 'resolve_action':
      return [
        `**Action ID:** ${input.action_id || input.id || 'unknown'}`,
        `**Resolution:** ${input.status || input.resolution || 'resolved'}`,
      ].join('\n')

    default:
      return `Will execute **${formatToolDisplayName(toolName)}** with the provided parameters.`
  }
}

// ─── Tool Category Icons ────────────────────────────────────────────────
// Map tool names to icon categories for the UI.

export type ToolIconCategory =
  | 'email'
  | 'slack'
  | 'calendar'
  | 'compliance'
  | 'memory'
  | 'database'
  | 'integration'
  | 'builtin'
  | 'default'

const TOOL_ICON_CATEGORIES: Record<string, ToolIconCategory> = {
  read_recent_emails: 'email',
  search_emails: 'email',
  read_email: 'email',
  draft_email: 'email',
  send_email: 'email',
  list_slack_channels: 'slack',
  read_slack_channel: 'slack',
  read_slack_thread: 'slack',
  read_slack_dms: 'slack',
  get_slack_mentions: 'slack',
  send_slack_dm: 'slack',
  post_to_channel: 'slack',
  send_approval_message: 'slack',
  update_slack_message: 'slack',
  get_today_events: 'calendar',
  get_week_events: 'calendar',
  find_free_slots: 'calendar',
  get_compliance_overview: 'compliance',
  list_failing_controls: 'compliance',
  get_audit_status: 'compliance',
  recall_memory: 'memory',
  store_memory: 'memory',
  update_memory: 'memory',
  query_commitments: 'database',
  create_commitment: 'database',
  update_commitment: 'database',
  query_actions: 'database',
  create_action: 'database',
  resolve_action: 'database',
  list_connected_integrations: 'integration',
  get_integration_health: 'integration',

  // Built-in SDK tools
  Bash: 'builtin',
  Read: 'builtin',
  Write: 'builtin',
  Glob: 'builtin',
  Grep: 'builtin',
}

export function getToolIconCategory(toolName: string): ToolIconCategory {
  return TOOL_ICON_CATEGORIES[toolName] || 'default'
}

// ─── Helpers ────────────────────────────────────────────────────────────

function truncate(str: string | undefined | null, maxLength: number): string {
  if (!str) return ''
  return str.length > maxLength ? str.slice(0, maxLength) + '...' : str
}
