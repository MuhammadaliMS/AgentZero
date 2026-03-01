import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { WebClient } from '@slack/web-api'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createSlackTools(orgId: string) {
  /**
   * Get a Slack client using the bot token (xoxb-).
   * Used for write operations — messages are sent as "Zerowing".
   */
  async function getSlackBotClient(): Promise<WebClient | null> {
    const tokens = await TokenManager.getTokens(orgId, 'slack')
    if (!tokens) return null
    return new WebClient(tokens.access_token)
  }

  /**
   * Get a Slack client using the user token (xoxp-) for read operations.
   * The user token sees everything the human user sees — including
   * Slack Connect channels, external connections, and all private channels.
   * Falls back to bot token if no user token is available.
   */
  async function getSlackUserClient(): Promise<WebClient | null> {
    const tokens = await TokenManager.getTokens(orgId, 'slack')
    if (!tokens) return null
    // Prefer user token for reads (sees Slack Connect channels etc.)
    // Fall back to bot token if user token wasn't granted
    const token = tokens.user_access_token || tokens.access_token
    return new WebClient(token)
  }

  // Keep backward-compatible alias for write tools
  const getSlackClient = getSlackBotClient

  // ─── Write Tools ─────────────────────────────────────────────────────────

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
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Send Slack DM', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  const postToChannel = tool(
    'post_to_channel',
    'Post a message to a Slack channel. Use list_slack_channels first to find the channel ID. Requires user approval for sending.',
    {
      channel_id: z.string().describe('Slack channel ID (e.g., C012345). Use list_slack_channels to find this.'),
      message: z.string().describe('Message text (supports Slack mrkdwn formatting)'),
      thread_ts: z.string().optional().describe('Reply to a thread — provide parent message timestamp'),
    },
    async (args) => {
      const client = await getSlackClient()
      if (!client) {
        return buildIntegrationRequiredResult('slack', 'Slack')
      }

      try {
        const result = await client.chat.postMessage({
          channel: args.channel_id,
          text: args.message,
          ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        })

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'posted',
              channel: result.channel,
              ts: result.ts,
              thread_ts: args.thread_ts || undefined,
            }),
          }],
        }
      } catch (e) {
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Post to Channel', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
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
        return handleSlackError(e)
      }
    },
    { annotations: { title: 'Send Approval Message', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  const updateSlackMessage = tool(
    'update_slack_message',
    'Update an existing Slack message. Use this to update approval messages after action is taken. Requires user approval before updating.',
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
        return handleSlackError(e)
      }
    },
    // ✅ destructiveHint: true — triggers approval gate in canUseTool
    { annotations: { title: 'Update Slack Message', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } }
  )

  // ─── Read Tools ─────────────────────────────────────────────────────────

  const listSlackChannels = tool(
    'list_slack_channels',
    'List Slack channels the user has access to, including Slack Connect (external) channels. Returns channel names, IDs, topics, and member counts. Use this to discover channels before reading messages or posting.',
    {
      types: z.enum(['public', 'private', 'dm', 'all']).optional().default('all')
        .describe('Filter by channel type'),
      limit: z.number().optional().default(50).describe('Max channels to return'),
    },
    async (args) => {
      const client = await getSlackUserClient()
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
      const client = await getSlackUserClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        const result = await client.conversations.history({
          channel: args.channel_id,
          limit: Math.min(args.limit, 100),
          ...(args.oldest ? { oldest: args.oldest } : {}),
        })

        // Resolve user IDs to names in parallel
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
      const client = await getSlackUserClient()
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
      const client = await getSlackUserClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        // Use bot client for lookupByEmail (needs bot token scope)
        const botClient = await getSlackBotClient()
        const lookupClient = botClient || client

        const userResult = await lookupClient.users.lookupByEmail({ email: args.user_email })
        if (!userResult.user?.id) {
          return { content: [{ type: 'text' as const, text: `Could not find Slack user: ${args.user_email}` }] }
        }

        // Open DM via bot client (im:write is a bot scope)
        const convResult = await lookupClient.conversations.open({ users: userResult.user.id })
        if (!convResult.channel?.id) {
          return { content: [{ type: 'text' as const, text: 'Could not open DM channel.' }] }
        }

        // Read history via user client (sees all messages including Slack Connect)
        const history = await client.conversations.history({
          channel: convResult.channel.id,
          limit: Math.min(args.limit, 50),
        })

        // auth.test on user client → returns the authenticated user's ID
        const authInfo = await client.auth.test()
        const authedUserId = authInfo.user_id

        const messages = (history.messages || []).reverse().map((msg) => ({
          from: msg.user === authedUserId ? 'You' : (userResult.user?.real_name || userResult.user?.name || msg.user),
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
    'Find recent messages that mention you (@you) and your unread DMs. Uses Slack search API for efficient retrieval instead of scanning all channels. Useful for "check my Slack" requests.',
    {
      hours_back: z.number().optional().default(24).describe('How many hours back to search'),
      limit: z.number().optional().default(30).describe('Max messages to return'),
    },
    async (args) => {
      const client = await getSlackUserClient()
      if (!client) return buildIntegrationRequiredResult('slack', 'Slack')

      try {
        // auth.test with user token → returns the authenticated user's ID
        const authInfo = await client.auth.test()
        const userId = authInfo.user_id

        const oldest = Math.floor(Date.now() / 1000) - args.hours_back * 3600

        // ✅ Optimized: Use search.messages API instead of scanning all channels.
        // This is O(1) API calls instead of O(N channels).
        const allMentions: Array<{
          channel_name: string
          channel_id: string
          user: string
          text: string
          ts: string
          time: string
          type: string
        }> = []

        // 1) Search for @mentions using Slack search API
        try {
          const searchResult = await client.search.messages({
            query: `<@${userId}> after:${new Date(oldest * 1000).toISOString().split('T')[0]}`,
            count: Math.min(args.limit, 50),
            sort: 'timestamp',
            sort_dir: 'desc',
          })

          for (const match of searchResult.messages?.matches || []) {
            allMentions.push({
              channel_name: (match.channel as { name?: string })?.name || 'unknown',
              channel_id: (match.channel as { id?: string })?.id || '',
              user: match.user || match.username || 'unknown',
              text: ((match.text || '') as string).slice(0, 500),
              ts: match.ts || '',
              time: match.ts ? new Date(parseFloat(match.ts) * 1000).toISOString() : '',
              type: 'mention',
            })
          }
        } catch {
          // search.messages may not be available with bot tokens — fall back below
        }

        // 2) Get recent DMs (check up to 10 DM channels)
        try {
          const dmChannels = await client.conversations.list({
            types: 'im,mpim',
            limit: 10,
            exclude_archived: true,
          })

          for (const ch of dmChannels.channels || []) {
            if (!ch.id) continue
            try {
              const history = await client.conversations.history({
                channel: ch.id,
                oldest: String(oldest),
                limit: 10,
              })

              for (const msg of history.messages || []) {
                if (msg.user === userId) continue // Skip own messages
                allMentions.push({
                  channel_name: ch.name || 'DM',
                  channel_id: ch.id,
                  user: msg.user || 'unknown',
                  text: ((msg.text || '') as string).slice(0, 500),
                  ts: msg.ts || '',
                  time: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
                  type: 'dm',
                })
              }
            } catch {
              continue
            }
          }
        } catch {
          // DM listing failed — continue with what we have
        }

        // Sort by timestamp descending (newest first) and limit
        allMentions.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
        const limited = allMentions.slice(0, args.limit)

        // Resolve user names in parallel
        const userIds = [...new Set(limited.map((m) => m.user).filter(u => u.startsWith('U')))]
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
    postToChannel,
    sendApprovalMessage,
    updateSlackMessage,
  ]
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Resolve Slack user IDs to display names — parallelized. */
async function resolveUserNames(client: WebClient, userIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}

  // ✅ Optimized: Parallel instead of sequential
  const results = await Promise.allSettled(
    userIds.map(async (uid) => {
      const info = await client.users.info({ user: uid })
      return { uid, name: info.user?.real_name || info.user?.name || uid }
    })
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      map[result.value.uid] = result.value.name
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
