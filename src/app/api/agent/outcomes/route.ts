import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getActiveOutcomes,
  getOutcomesForConversation,
  createOutcome,
} from '@/lib/agent/runtime/outcome-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/outcomes
 * List active outcomes for the authenticated user's org.
 * Query params: conversation_id?, limit?
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '10', 10), 50)

  if (conversationId) {
    const outcomes = await getOutcomesForConversation(profile.org_id, conversationId, limit)
    return NextResponse.json({ outcomes, total: outcomes.length })
  }

  const outcomes = await getActiveOutcomes(profile.org_id, limit)
  return NextResponse.json({ outcomes, total: outcomes.length })
}

/**
 * POST /api/agent/outcomes
 * Start a new outcome.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const body = await request.json()
  const outcomeId = await createOutcome({
    orgId: profile.org_id,
    conversationId: body.conversation_id,
    title: body.title,
    description: body.description,
    goalType: body.goal_type,
    ownerUserId: user.id,
    priority: body.priority,
    relatedEntityIds: body.related_entity_ids,
  })

  if (!outcomeId) {
    return NextResponse.json({ error: 'Failed to create outcome' }, { status: 500 })
  }

  return NextResponse.json({ id: outcomeId }, { status: 201 })
}
