import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCaptainWithSDK } from '@/lib/agent/sdk-switch'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'

/**
 * Generate a brief for a specific user
 * Called by cron jobs or manually
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // Allow both CRON_SECRET and authenticated user requests
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { orgId, userId, type = 'morning' } = body as {
    orgId: string
    userId: string
    type?: 'morning' | 'eod' | 'weekly'
  }

  if (!orgId || !userId) {
    return NextResponse.json({ error: 'orgId and userId required' }, { status: 400 })
  }

  const promptMap = {
    morning:
      'Generate my morning brief. Include: today\'s calendar events, urgent emails, at-risk commitments, pending actions needing my approval, and any compliance alerts. Be concise and prioritize by urgency.',
    eod:
      'Generate my end-of-day wrap. Summarize: what was accomplished today, any items carrying forward, pending actions still open, and a brief preview of tomorrow.',
    weekly:
      'Generate my weekly summary. Cover: key accomplishments this week, commitments completed vs at-risk, compliance posture changes, and priorities for next week.',
  }

  try {
    let fullResponse = ''
    // Generate a temporary conversation ID for the brief generation run
    const briefConversationId = `brief-${type}-${Date.now()}`
    const agentStream = runCaptainWithSDK({
      orgId,
      userId,
      message: promptMap[type],
      conversationId: briefConversationId,
    })

    for await (const event of agentStream) {
      if (event.type === 'text' && event.content) {
        fullResponse += event.content
      }
    }

    // Store the brief
    const admin = createAdminClient()
    const { data: brief } = await admin
      .from('briefs')
      .insert({
        org_id: orgId,
        user_id: userId,
        type,
        title: `${type.charAt(0).toUpperCase() + type.slice(1)} Brief`,
        content: { text: fullResponse },
        status: 'draft',
      })
      .select('id')
      .single()

    return NextResponse.json({
      ok: true,
      briefId: brief?.id,
      content: fullResponse,
    })
  } catch (error) {
    console.error('Error generating brief:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate brief' },
      { status: 500 }
    )
  }
}
