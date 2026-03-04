import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { trackUtilityEvent, type UtilityEventType } from '@/lib/graph/utility-tracker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/memory/feedback
 *
 * Record a utility event from the UI (user marks memory helpful/unhelpful).
 *
 * Body: { entityId?, memoryId?, insightId?, eventType, conversationId?, sourceChannel? }
 */
export async function POST(request: NextRequest) {
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

  const body = await request.json()
  const { entityId, memoryId, insightId, eventType, conversationId, sourceChannel } = body

  // Only allow user-facing stages from the client. Internal stages
  // (retrieved, injected) are recorded server-side and should not
  // be controllable from the UI to prevent metric inflation.
  const clientAllowedTypes: UtilityEventType[] = ['cited', 'accepted', 'acted']
  if (!eventType || !clientAllowedTypes.includes(eventType)) {
    return NextResponse.json(
      { error: 'Invalid eventType. Allowed: cited, accepted, acted' },
      { status: 400 }
    )
  }

  // Validate ownership: ensure the referenced entity/memory/insight belongs to the user's org
  if (entityId) {
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('id', entityId)
      .eq('org_id', profile.org_id)
      .maybeSingle()
    if (!entity) {
      return NextResponse.json({ error: 'Entity not found in org' }, { status: 404 })
    }
  }

  if (insightId) {
    const { data: insight } = await supabase
      .from('graph_insights')
      .select('id')
      .eq('id', insightId)
      .eq('org_id', profile.org_id)
      .maybeSingle()
    if (!insight) {
      return NextResponse.json({ error: 'Insight not found in org' }, { status: 404 })
    }
  }

  if (memoryId) {
    const { data: mem } = await supabase
      .from('memory')
      .select('id')
      .eq('id', memoryId)
      .eq('org_id', profile.org_id)
      .maybeSingle()
    if (!mem) {
      return NextResponse.json({ error: 'Memory not found in org' }, { status: 404 })
    }
  }

  await trackUtilityEvent(profile.org_id, {
    entityId,
    memoryId,
    insightId,
    eventType,
    conversationId,
    sourceChannel,
  })

  return NextResponse.json({ ok: true })
}
