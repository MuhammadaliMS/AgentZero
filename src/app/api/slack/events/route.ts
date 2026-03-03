import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { verifySlackRequest } from '@/lib/slack/verify'
import { getSlackClient } from '@/lib/slack/client'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCaptainWithSDK } from '@/lib/agent/sdk-switch'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 2 minutes for agent processing

export async function POST(request: NextRequest) {
  const body = await request.text()
  const payload = JSON.parse(body)

  // Handle URL verification challenge FIRST (before signature check)
  // This must respond quickly for Slack to verify the endpoint
  if (payload.type === 'url_verification') {
    console.log('[Slack Events] URL verification challenge received')
    return NextResponse.json({ challenge: payload.challenge })
  }

  const timestamp = request.headers.get('x-slack-request-timestamp') || ''
  const signature = request.headers.get('x-slack-signature') || ''

  // Verify request signature for all other events
  if (!verifySlackRequest(body, timestamp, signature)) {
    console.error('[Slack Events] Invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Handle events
  if (payload.type === 'event_callback') {
    const event = payload.event

    // Handle direct messages to the bot
    if (event.type === 'message' && !event.bot_id && event.channel_type === 'im') {
      waitUntil(handleDmMessage(event, payload.team_id).catch((err) => {
        console.error('[Slack Events] Unhandled error in handleDmMessage:', err)
      }))
    }

    // Handle @mentions of the bot in channels
    if (event.type === 'app_mention' && !event.bot_id) {
      waitUntil(handleAppMention(event, payload.team_id).catch((err) => {
        console.error('[Slack Events] Unhandled error in handleAppMention:', err)
      }))
    }
  }

  return NextResponse.json({ ok: true })
}

/**
 * Resolve org and user from a Slack team ID and user ID.
 */
async function resolveOrgAndUser(
  teamId: string,
  slackUserId: string
): Promise<{ orgId: string; userId: string; slackClient: Awaited<ReturnType<typeof getSlackClient>> } | null> {
  const admin = createAdminClient()

  // Find the org by Slack workspace ID
  const { data: orgIntegration } = await admin
    .from('organization_integrations')
    .select('org_id, user_metadata')
    .eq('is_active', true)
    .filter('user_metadata->>workspace_id', 'eq', teamId)
    .single()

  if (!orgIntegration) {
    console.error(`[Slack Events] No org found for Slack team ${teamId}`)
    return null
  }

  const orgId = orgIntegration.org_id
  const slackClient = await getSlackClient(orgId)
  if (!slackClient) {
    console.error(`[Slack Events] No Slack client for org ${orgId}`)
    return null
  }

  let userId: string | null = null

  try {
    const slackUser = await slackClient.users.info({ user: slackUserId })
    const email = slackUser.user?.profile?.email

    if (email) {
      const { data: profile } = await admin
        .from('profiles')
        .select('id')
        .eq('org_id', orgId)
        .eq('email', email)
        .single()

      userId = profile?.id || null
    }
  } catch (err) {
    console.error(`[Slack Events] Failed to look up Slack user ${slackUserId}:`, err)
  }

  if (!userId) {
    console.error(`[Slack Events] Could not resolve Slack user ${slackUserId} to a profile in org ${orgId}`)
    return null
  }

  return { orgId, userId, slackClient }
}

/**
 * Run the agent and collect the full text response.
 */
async function runAgentForSlack(
  orgId: string,
  userId: string,
  message: string
): Promise<string> {
  const conversationId = crypto.randomUUID()
  let fullResponse = ''
  let errorMessage = ''

  console.log(`[Slack Events] Running agent: org=${orgId}, user=${userId}, msg="${message.slice(0, 100)}", convId=${conversationId}`)

  const agentStream = runCaptainWithSDK({
    orgId,
    userId,
    message,
    conversationId,
  })

  for await (const event of agentStream) {
    if (event.type === 'text' && event.content) {
      fullResponse += event.content
    }
    if (event.type === 'error' && event.content) {
      errorMessage = event.content
      console.error(`[Slack Events] Agent error event: ${event.content}`)
    }
  }

  if (fullResponse) {
    return fullResponse
  }
  if (errorMessage) {
    return `⚠️ ${errorMessage}`
  }

  console.error(`[Slack Events] No text or error events from agent stream (convId=${conversationId})`)
  return ''
}

/**
 * Handle DM messages to the bot.
 */
async function handleDmMessage(
  event: { user: string; text: string; channel: string; ts: string },
  teamId: string
) {
  const resolved = await resolveOrgAndUser(teamId, event.user)
  if (!resolved) {
    // Try to respond if we can get a client
    const admin = createAdminClient()
    const { data: orgIntegration } = await admin
      .from('organization_integrations')
      .select('org_id')
      .eq('is_active', true)
      .filter('user_metadata->>workspace_id', 'eq', teamId)
      .single()

    if (orgIntegration) {
      const client = await getSlackClient(orgIntegration.org_id)
      if (client) {
        await client.chat.postMessage({
          channel: event.channel,
          text: "I couldn't identify your account. Please make sure you're set up in Zerowing.",
          thread_ts: event.ts,
        })
      }
    }
    return
  }

  const { orgId, userId, slackClient } = resolved

  try {
    // Strip bot mention from message text (Slack sometimes includes it in DMs)
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim() || event.text

    const response = await runAgentForSlack(orgId, userId, cleanText)

    if (response) {
      await slackClient!.chat.postMessage({
        channel: event.channel,
        text: response,
        thread_ts: event.ts,
      })
    } else {
      await slackClient!.chat.postMessage({
        channel: event.channel,
        text: "Sorry, I couldn't generate a response. Please try again.",
        thread_ts: event.ts,
      })
    }
  } catch (error) {
    console.error('[Slack Events] Error processing DM:', error)
    await slackClient!.chat.postMessage({
      channel: event.channel,
      text: 'Sorry, I encountered an error processing your message. Please try again.',
      thread_ts: event.ts,
    })
  }
}

/**
 * Handle @mentions of the bot in channels.
 */
async function handleAppMention(
  event: { user: string; text: string; channel: string; ts: string },
  teamId: string
) {
  const resolved = await resolveOrgAndUser(teamId, event.user)
  if (!resolved) {
    return // Can't respond without org context
  }

  const { orgId, userId, slackClient } = resolved

  try {
    // Strip the bot mention from the message text
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()

    if (!cleanText) {
      await slackClient!.chat.postMessage({
        channel: event.channel,
        text: "Hi! How can I help? Try asking me to check your Slack, summarize a channel, or prep you for a meeting.",
        thread_ts: event.ts,
      })
      return
    }

    const response = await runAgentForSlack(orgId, userId, cleanText)

    if (response) {
      await slackClient!.chat.postMessage({
        channel: event.channel,
        text: response,
        thread_ts: event.ts,
      })
    } else {
      await slackClient!.chat.postMessage({
        channel: event.channel,
        text: "Sorry, I couldn't generate a response. Please try again.",
        thread_ts: event.ts,
      })
    }
  } catch (error) {
    console.error('[Slack Events] Error processing app_mention:', error)
    await slackClient!.chat.postMessage({
      channel: event.channel,
      text: 'Sorry, I encountered an error. Please try again.',
      thread_ts: event.ts,
    })
  }
}
