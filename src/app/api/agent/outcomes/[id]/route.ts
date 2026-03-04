import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOutcomeWithPlan, updateOutcomeStatus } from '@/lib/agent/runtime/outcome-runtime'
import type { OutcomeStatus } from '@/lib/agent/runtime/outcome-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/outcomes/[id]
 * Full outcome status with current run and steps.
 * Enforces org ownership — users can only read outcomes belonging to their org.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Look up user's org for ownership check
  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  // Pass orgId to enforce ownership — returns null if outcome doesn't belong to this org
  const result = await getOutcomeWithPlan(id, profile.org_id)
  if (!result) return NextResponse.json({ error: 'Outcome not found' }, { status: 404 })

  return NextResponse.json(result)
}

/**
 * PATCH /api/agent/outcomes/[id]
 * Update outcome status (cancel, etc.)
 * Enforces org ownership — users can only modify outcomes belonging to their org.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Look up user's org for ownership check
  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const body = await request.json()
  const status = body.status as OutcomeStatus

  if (!['cancelled', 'completed', 'failed'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status transition' }, { status: 400 })
  }

  // Pass orgId to enforce ownership — prevents cross-org mutation
  const ok = await updateOutcomeStatus(id, status, {
    blockerSummary: body.blocker_summary,
    orgId: profile.org_id,
  })

  if (!ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json({ success: true })
}
