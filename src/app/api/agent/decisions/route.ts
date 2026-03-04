import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getDecisionCardsForConversation,
  getRecentDecisionCards,
  type DecisionCardTriggerType,
} from '@/lib/agent/reasoning/decision-card'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/decisions
 *
 * List decision cards for the authenticated user's org.
 *
 * Query params:
 *   - conversation_id?: string — filter by conversation
 *   - trigger_type?: string — filter by trigger type
 *   - limit?: number — max results (default 20, max 50)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')
  const triggerType = searchParams.get('trigger_type') as DecisionCardTriggerType | null
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)

  if (conversationId) {
    const cards = await getDecisionCardsForConversation(
      profile.org_id,
      conversationId,
      limit
    )
    return NextResponse.json({ cards, total: cards.length })
  }

  const cards = await getRecentDecisionCards(
    profile.org_id,
    limit,
    triggerType ?? undefined
  )
  return NextResponse.json({ cards, total: cards.length })
}
