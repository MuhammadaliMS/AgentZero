import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { recordInterventionFeedback } from '@/lib/intelligence/intervention-triage'
import type { UserResponseType } from '@/lib/intelligence/intervention-triage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/interventions/[id]/feedback
 * Record user response to an intervention.
 * Body: { user_response, source_category? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: triageId } = await params
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
  const userResponse = body.user_response as UserResponseType

  if (!['accepted', 'deferred', 'ignored', 'rejected'].includes(userResponse)) {
    return NextResponse.json({ error: 'Invalid user_response' }, { status: 400 })
  }

  await recordInterventionFeedback(
    profile.org_id,
    user.id,
    triageId,
    body.intervention_type ?? 'unknown',
    body.intervention_summary ?? '',
    userResponse,
    body.source_category,
  )

  return NextResponse.json({ success: true })
}
