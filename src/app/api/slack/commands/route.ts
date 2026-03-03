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
  const timestamp = request.headers.get('x-slack-request-timestamp') || ''
  const signature = request.headers.get('x-slack-signature') || ''

  if (!verifySlackRequest(body, timestamp, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const params = new URLSearchParams(body)
  const command = params.get('command')
  const text = params.get('text') || ''
  const teamId = params.get('team_id') || ''
  const userId = params.get('user_id') || ''
  const channelId = params.get('channel_id') || ''
  const responseUrl = params.get('response_url') || ''

  if (command !== '/zerowing') {
    return NextResponse.json({ text: 'Unknown command' })
  }

  // Respond immediately with acknowledgment
  // Use waitUntil to keep the function alive for background processing
  waitUntil(processCommand(text, teamId, userId, channelId, responseUrl).catch((err) => {
    console.error('[Slack Commands] Unhandled error in processCommand:', err)
  }))

  return NextResponse.json({
    response_type: 'ephemeral',
    text: 'Processing your request...',
  })
}

async function processCommand(
  text: string,
  teamId: string,
  slackUserId: string,
  channelId: string,
  responseUrl: string
) {
  const admin = createAdminClient()

  // Find org by team ID
  const { data: orgIntegration } = await admin
    .from('organization_integrations')
    .select('org_id')
    .eq('is_active', true)
    .filter('user_metadata->>workspace_id', 'eq', teamId)
    .single()

  if (!orgIntegration) {
    await postToResponseUrl(responseUrl, 'Organization not found. Please connect Slack in Zerowing first.')
    return
  }

  const orgId = orgIntegration.org_id

  // Find user
  const slackClient = await getSlackClient(orgId)
  let profileId: string | null = null

  if (slackClient) {
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

        profileId = profile?.id || null
      }
    } catch (err) {
      console.error(`[Slack Commands] Failed to look up Slack user ${slackUserId}:`, err)
    }
  }

  if (!profileId) {
    console.error(`[Slack Commands] Could not resolve Slack user ${slackUserId} to a profile in org ${orgId}`)
    await postToResponseUrl(responseUrl, 'Could not identify your account. Please make sure your Slack email matches your Zerowing account.')
    return
  }

  // Handle subcommands
  const message = text.trim() || "What's on my plate today?"

  // Generate a proper UUID for the conversation ID (DB column is uuid type)
  const conversationId = crypto.randomUUID()

  try {
    let fullResponse = ''
    let errorMessage = ''

    console.log(`[Slack Commands] Running agent: org=${orgId}, user=${profileId}, msg="${message.slice(0, 100)}", convId=${conversationId}`)

    const agentStream = runCaptainWithSDK({
      orgId,
      userId: profileId,
      message,
      conversationId,
    })

    for await (const event of agentStream) {
      if (event.type === 'text' && event.content) {
        fullResponse += event.content
      }
      // Capture error events so we don't silently swallow agent failures
      if (event.type === 'error' && event.content) {
        errorMessage = event.content
        console.error(`[Slack Commands] Agent error event: ${event.content}`)
      }
    }

    if (fullResponse) {
      await postToResponseUrl(responseUrl, fullResponse)
    } else if (errorMessage) {
      await postToResponseUrl(responseUrl, `⚠️ ${errorMessage}`)
    } else {
      console.error(`[Slack Commands] No text or error events from agent stream (convId=${conversationId})`)
      await postToResponseUrl(responseUrl, 'Sorry, I couldn\'t generate a response. Please try again.')
    }
  } catch (error) {
    console.error('[Slack Commands] Error processing command:', error)
    await postToResponseUrl(responseUrl, 'Sorry, I encountered an error. Please try again.')
  }
}

async function postToResponseUrl(url: string, text: string) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response_type: 'ephemeral',
      text,
    }),
  })
}
