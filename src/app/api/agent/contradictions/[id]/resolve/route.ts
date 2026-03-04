import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveContradiction } from '@/lib/graph/contradiction-detector'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/contradictions/[id]/resolve
 *
 * User resolves a contradiction by choosing which side is correct.
 *
 * Body: { chosenTruth: Record<string, unknown>, rationale?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contradictionId } = await params

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

  // Verify the contradiction belongs to this org
  const { data: insight } = await supabase
    .from('graph_insights')
    .select('id, org_id')
    .eq('id', contradictionId)
    .eq('org_id', profile.org_id)
    .eq('insight_type', 'contradiction')
    .single()

  if (!insight) {
    return NextResponse.json({ error: 'Contradiction not found' }, { status: 404 })
  }

  const body = await request.json()
  const { chosenTruth, rationale } = body

  if (!chosenTruth || typeof chosenTruth !== 'object') {
    return NextResponse.json({ error: 'chosenTruth is required' }, { status: 400 })
  }

  await resolveContradiction(
    profile.org_id,
    contradictionId,
    chosenTruth,
    user.id,
    'chat',
    rationale
  )

  return NextResponse.json({ ok: true, resolved: contradictionId })
}
