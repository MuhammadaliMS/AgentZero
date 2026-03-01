import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { verifySlackRequest } from '@/lib/slack/verify'
import { getSlackClient } from '@/lib/slack/client'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildResolvedBlocks } from '@/lib/slack/blocks'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const formData = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') || ''
  const signature = request.headers.get('x-slack-signature') || ''

  if (!verifySlackRequest(formData, timestamp, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Slack sends interaction payloads as form-encoded with a "payload" field
  const params = new URLSearchParams(formData)
  const payload = JSON.parse(params.get('payload') || '{}')

  if (payload.type === 'block_actions') {
    // Process asynchronously - keep function alive with waitUntil
    waitUntil(handleBlockAction(payload).catch(console.error))
  }

  // Must respond within 3 seconds
  return NextResponse.json({ ok: true })
}

async function handleBlockAction(payload: {
  actions: Array<{ action_id: string; value: string }>
  user: { id: string; name: string }
  team: { id: string }
  channel: { id: string }
  message: { ts: string }
}) {
  const action = payload.actions[0]
  if (!action) return

  const actionId = action.value
  const resolution = action.action_id.replace('_action', '') as 'approve' | 'reject' | 'defer'

  const admin = createAdminClient()

  // Map resolution to status
  const statusMap: Record<string, 'approved' | 'rejected' | 'deferred' | 'pending'> = {
    approve: 'approved',
    reject: 'rejected',
    defer: 'deferred',
  }
  const newStatus = statusMap[resolution] || 'pending'

  // Update the action in the database
  const { data: actionData } = await admin
    .from('actions')
    .update({
      status: newStatus,
      resolved_at: new Date().toISOString(),
      resolved_by: payload.user.id,
    })
    .eq('id', actionId)
    .select('title, org_id')
    .single()

  if (!actionData) {
    console.error(`Action ${actionId} not found`)
    return
  }

  // Update the Slack message to show resolution
  const slackClient = await getSlackClient(actionData.org_id)
  if (!slackClient) return

  const resolvedBlocks = buildResolvedBlocks({
    title: actionData.title,
    resolution: newStatus as 'approved' | 'rejected' | 'deferred',
    resolvedBy: payload.user.name,
  })

  try {
    await slackClient.chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `${actionData.title} — ${newStatus}`,
      blocks: resolvedBlocks,
    })
  } catch (error) {
    console.error('Error updating Slack message:', error)
  }
}
