import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { WebClient } from '@slack/web-api'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createSlackTools(orgId: string) {
  async function getSlackClient(): Promise<WebClient | null> {
    const tokens = await TokenManager.getTokens(orgId, 'slack')
    if (!tokens) return null
    return new WebClient(tokens.access_token)
  }

  const sendSlackDm = tool(
    'send_slack_dm',
    'Send a direct message to a user via Slack. Use this for nudges, briefs, or quick updates. Requires user approval for sending.',
    {
      user_email: z.string().describe('Email address of the Slack user to DM'),
      message: z.string().describe('Message text (supports Slack mrkdwn formatting)'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) {
        return buildIntegrationRequiredResult('slack', 'Slack')
      }

      try {
        const userResult = await client.users.lookupByEmail({ email: args.user_email })
        if (!userResult.user?.id) {
          return { content: [{ type: 'text' as const, text: `Could not find Slack user with email: ${args.user_email}` }] }
        }

        const conversationResult = await client.conversations.open({ users: userResult.user.id })
        if (!conversationResult.channel?.id) {
          return { content: [{ type: 'text' as const, text: 'Could not open DM channel.' }] }
        }

        const result = await client.chat.postMessage({
          channel: conversationResult.channel.id,
          text: args.message,
        })

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'sent',
              channel: conversationResult.channel.id,
              ts: result.ts,
              user: userResult.user.real_name || userResult.user.name,
            }),
          }],
        }
      } catch (e) {
        const msg = (e as Error).message || ''
        // Auth failures (invalid_auth, token_revoked, not_authed) → trigger integration card
        if (msg.includes('invalid_auth') || msg.includes('token_revoked') || msg.includes('not_authed') || msg.includes('account_inactive')) {
          return buildIntegrationRequiredResult('slack', 'Slack')
        }
        return { content: [{ type: 'text' as const, text: `Slack error: ${msg}` }] }
      }
    },
    { annotations: { title: 'Send Slack DM', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  const sendApprovalMessage = tool(
    'send_approval_message',
    'Send an approval request via Slack DM with Approve/Reject buttons. Use this for actions that require human-in-the-loop approval.',
    {
      user_email: z.string().describe('Email of the approver'),
      title: z.string().describe('Title of the approval request'),
      description: z.string().describe('Details about what needs approval'),
      action_id: z.string().describe('The action ID from the actions table'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) {
        return buildIntegrationRequiredResult('slack', 'Slack')
      }

      try {
        const userResult = await client.users.lookupByEmail({ email: args.user_email })
        if (!userResult.user?.id) {
          return { content: [{ type: 'text' as const, text: `Could not find Slack user: ${args.user_email}` }] }
        }

        const conversationResult = await client.conversations.open({ users: userResult.user.id })
        if (!conversationResult.channel?.id) {
          return { content: [{ type: 'text' as const, text: 'Could not open DM channel.' }] }
        }

        const priorityEmoji = {
          critical: ':rotating_light:',
          high: ':red_circle:',
          medium: ':large_orange_circle:',
          low: ':white_circle:',
        }

        const result = await client.chat.postMessage({
          channel: conversationResult.channel.id,
          text: `Approval needed: ${args.title}`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `${args.priority ? priorityEmoji[args.priority] + ' ' : ''}Approval Needed` },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*${args.title}*\n\n${args.description}` },
            },
            { type: 'divider' },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Approve' },
                  style: 'primary',
                  action_id: 'approve_action',
                  value: args.action_id,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Reject' },
                  style: 'danger',
                  action_id: 'reject_action',
                  value: args.action_id,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Defer' },
                  action_id: 'defer_action',
                  value: args.action_id,
                },
              ],
            },
          ],
        })

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'approval_sent',
              channel: conversationResult.channel.id,
              ts: result.ts,
              action_id: args.action_id,
            }),
          }],
        }
      } catch (e) {
        const msg = (e as Error).message || ''
        if (msg.includes('invalid_auth') || msg.includes('token_revoked') || msg.includes('not_authed') || msg.includes('account_inactive')) {
          return buildIntegrationRequiredResult('slack', 'Slack')
        }
        return { content: [{ type: 'text' as const, text: `Slack error: ${msg}` }] }
      }
    },
    { annotations: { title: 'Send Approval Message', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  const updateSlackMessage = tool(
    'update_slack_message',
    'Update an existing Slack message. Use this to update approval messages after action is taken.',
    {
      channel: z.string().describe('Slack channel ID'),
      ts: z.string().describe('Message timestamp to update'),
      text: z.string().describe('New message text'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) {
        return buildIntegrationRequiredResult('slack', 'Slack')
      }

      try {
        await client.chat.update({
          channel: args.channel,
          ts: args.ts,
          text: args.text,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: args.text },
            },
          ],
        })

        return { content: [{ type: 'text' as const, text: 'Message updated.' }] }
      } catch (e) {
        const msg = (e as Error).message || ''
        if (msg.includes('invalid_auth') || msg.includes('token_revoked') || msg.includes('not_authed') || msg.includes('account_inactive')) {
          return buildIntegrationRequiredResult('slack', 'Slack')
        }
        return { content: [{ type: 'text' as const, text: `Slack error: ${msg}` }] }
      }
    },
    { annotations: { title: 'Update Slack Message', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  // ─── Read Tools ─────────────────────────────────────────────────────────

  const listSlackChannels = tool(
    'list_slack_channels',
    'List Slack channels the bot has access to. Returns channel names, IDs, topics, and member counts. Use this to discover channels before reading messages.',
    {
      types: z.enum(['public', 'private', 'dm', 'all']).optional().default('all')
        .describe('Filter by channel type'),
      limit: z.number().optional().default(50).describe('Max channels to return'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const types: string[] = []
        if (args.types === 'all' || args.types === 'public') types.push('public_channel')
        if (args.types === 'all' || args.types === 'private') types.push('private_channel')
        if (args.types === 'all' || args.types === 'dm') types.push('im', 'mpim')

        const result = await client.conversations.list({
          types: types.join(','),
          limit: args.limit,
          exclude_archived: true,
        })

        const channels = (result.channels || []).map((ch) => ({
          id: ch.id,
          name: ch.name || ch.id,
          type: ch.is_im ? 'dm' : ch.is_mpim ? 'group_dm' : ch.is_private ? 'private' : 'public',
          topic: (ch.topic as { value?: string })?.value || undefined,
          purpose: (ch.purpose as { value?: string })?.value || undefined,
          num_members: ch.num_members,
        }))

        return { content: [{ type: 'text' as const, text: JSON.stringify(channels, null, 2) }] }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'List Slack Channels', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const readSlackChannel = tool(
    'read_slack_channel',
    'Read recent messages from a Slack channel. Returns message text, author, timestamps, and reactions. Use list_slack_channels first to find channel IDs.',
    {
      channel_id: z.string().describe('Slack channel ID (e.g., C012345)'),
      limit: z.number().optional().default(25).describe('Number of messages to fetch (max 100)'),
      oldest: z.string().optional().describe('Only messages after this Unix timestamp'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const result = await client.conversations.history({
          channel: args.channel_id,
          limit: Math.min(args.limit, 100),
          ...(args.oldest ? { oldest: args.oldest } : {}),
        })

        // Resolve user IDs to names for readability
        const userIds = new Set<string>()
        for (const msg of result.messages || []) {
          if (msg.user) userIds.add(msg.user)
        }
        const userMap = await resolveUserNames(client, Array.from(userIds))

        const messages = (result.messages || []).reverse().map((msg) => ({
          user: userMap[msg.user || ''] || msg.user || 'unknown',
          text: msg.text || '',
          ts: msg.ts,
          time: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : undefined,
          thread_reply_count: (msg as Record<string, unknown>).reply_count || undefined,
          reactions: ((msg as Record<string, unknown>).reactions as Array<{ name: string; count: number }> || [])
            .map((r) => `${r.name}(${r.count})`).join(', ') || undefined,
        }))

        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Read Slack Channel', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const readSlackThread = tool(
    'read_slack_thread',
    'Read replies in a Slack thread. Use this to get the full context of a threaded conversation.',
    {
      channel_id: z.string().describe('Slack channel ID'),
      thread_ts: z.string().describe('Timestamp of the parent message (from read_slack_channel results)'),
      limit: z.number().optional().default(50).describe('Max replies to fetch'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const result = await client.conversations.replies({
          channel: args.channel_id,
          ts: args.thread_ts,
          limit: Math.min(args.limit, 100),
        })

        const userIds = new Set<string>()
        for (const msg of result.messages || []) {
          if (msg.user) userIds.add(msg.user)
        }
        const userMap = await resolveUserNames(client, Array.from(userIds))

        const messages = (result.messages || []).map((msg) => ({
          user: userMap[msg.user || ''] || msg.user || 'unknown',
          text: msg.text || '',
          ts: msg.ts,
          time: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : undefined,
        }))

        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Read Slack Thread', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const readSlackDms = tool(
    'read_slack_dms',
    'Read recent direct messages from a specific user. Looks up the user by email, opens/finds the DM channel, and reads recent messages.',
    {
      user_email: z.string().describe('Email of the Slack user whose DMs to read'),
      limit: z.number().optional().default(20).describe('Number of messages to fetch'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const userResult = await client.users.lookupByEmail({ email: args.user_email })
        if (!userResult.user?.id) {
          return { content: [{ type: 'text' as const, text: `Could not find Slack user: ${args.user_email}` }] }
        }

        const convResult = await client.conversations.open({ users: userResult.user.id })
        if (!convResult.channel?.id) {
          return { content: [{ type: 'text' as const, text: 'Could not open DM channel.' }] }
        }

        const history = await client.conversations.history({
          channel: convResult.channel.id,
          limit: Math.min(args.limit, 50),
        })

        const botInfo = await client.auth.test()
        const botUserId = botInfo.user_id

        const messages = (history.messages || []).reverse().map((msg) => ({
          from: msg.user === botUserId ? 'Axari (bot)' : (userResult.user?.real_name || userResult.user?.name || msg.user),
          text: msg.text || '',
          ts: msg.ts,
          time: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : undefined,
        }))

        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Read Slack DMs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const getSlackMentions = tool(
    'get_slack_mentions',
    'Find recent messages that mention the bot or the authenticated user across channels the bot is in. Useful for "check my Slack" requests — surfaces DMs, @mentions, and messages needing attention.',
    {
      hours_back: z.number().optional().default(24).describe('How many hours back to search'),
      limit: z.number().optional().default(30).describe('Max messages to return across all channels'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const botInfo = await client.auth.test()
        const botUserId = botInfo.user_id
        const oldest = String(Math.floor(Date.now() / 1000) - args.hours_back * 3600)

        // Get channels the bot is in
        const channelResult = await client.conversations.list({
          types: 'public_channel,private_channel,im,mpim',
          limit: 100,
          exclude_archived: true,
        })

        const allMentions: Array<{
          channel_name: string
          channel_id: string
          user: string
          text: string
          ts: string
          time: string
          type: string
        }> = []

        // Scan DM channels and channels for recent messages
        for (const ch of channelResult.channels || []) {
          if (!ch.id) continue

          // For DMs, read all recent messages
          // For channels, we'll check for mentions of the bot
          const isDm = ch.is_im || ch.is_mpim

          try {
            const history = await client.conversations.history({
              channel: ch.id,
              oldest,
              limit: isDm ? 20 : 50,
            })

            for (const msg of history.messages || []) {
              // Skip bot's own messages
              if (msg.user === botUserId) continue

              const isMention = (msg.text || '').includes(`<@${botUserId}>`)
              const isDirectMessage = isDm

              if (isMention || isDirectMessage) {
                allMentions.push({
                  channel_name: ch.name || (isDm ? `DM` : ch.id || 'unknown'),
                  channel_id: ch.id,
                  user: msg.user || 'unknown',
                  text: (msg.text || '').slice(0, 500),
                  ts: msg.ts || '',
                  time: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
                  type: isDm ? 'dm' : 'mention',
                })
              }
            }
          } catch {
            // Skip channels we can't read (not a member, etc.)
            continue
          }

          // Stop if we have enough
          if (allMentions.length >= args.limit) break
        }

        // Sort by timestamp descending (newest first) and limit
        allMentions.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
        const limited = allMentions.slice(0, args.limit)

        // Resolve user names
        const userIds = [...new Set(limited.map((m) => m.user))]
        const userMap = await resolveUserNames(client, userIds)
        for (const m of limited) {
          m.user = userMap[m.user] || m.user
        }

        if (limited.length === 0) {
          return { content: [{ type: 'text' as const, text: `No mentions or DMs found in the last ${args.hours_back} hours.` }] }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(limited, null, 2) }] }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Get Slack Mentions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [
    // Read tools
    listSlackChannels,
    readSlackChannel,
    readSlackThread,
    readSlackDms,
    getSlackMentions,
    // Write tools
    sendSlackDm,
    sendApprovalMessage,
    updateSlackMessage,
  ]
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Resolve Slack user IDs to display names. */
async function resolveUserNames(client: WebClient, userIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid })
      map[uid] = info.user?.real_name || info.user?.name || uid
    } catch {
      map[uid] = uid
    }
  }
  return map
}

/** Standardized Slack error handling — returns integration required for auth errors. */
function handleSlackError(e: unknown) {
  const msg = (e as Error).message || ''
  if (msg.includes('invalid_auth') || msg.includes('token_revoked') || msg.includes('not_authed') || msg.includes('account_inactive')) {
    return buildIntegrationRequiredResult('slack', 'Slack')
  }
  return { content: [{ type: 'text' as const, text: `Slack error: ${msg}` }] }
}
