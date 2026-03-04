import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/entities/[id]/pin
 *
 * Pin or unpin an entity. Pinned entities are immune to decay.
 *
 * Body: { pinned: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: entityId } = await params

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

  const admin = createAdminClient()

  // Verify entity belongs to org
  const { data: entity } = await admin
    .from('entities')
    .select('id, name, state, is_pinned')
    .eq('id', entityId)
    .eq('org_id', profile.org_id)
    .single()

  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
  }

  const body = await request.json()
  const pinned = body.pinned === true

  const updates: Record<string, unknown> = {
    is_pinned: pinned,
    updated_at: new Date().toISOString(),
  }

  // Update state based on pin action
  if (pinned) {
    updates.state = 'pinned'
  } else if (entity.state === 'pinned') {
    // Unpin: revert to active
    updates.state = 'active'
  }

  await admin
    .from('entities')
    .update(updates)
    .eq('id', entityId)
    .eq('org_id', profile.org_id)

  return NextResponse.json({
    ok: true,
    entity: entity.name,
    pinned,
    state: updates.state ?? entity.state,
  })
}
