import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { updateStep, validateStepBelongsToOutcome } from '@/lib/agent/runtime/outcome-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/outcomes/[id]/input
 * Resolve a blocked step by providing user input.
 * Body: { step_id, input_value }
 *
 * Security: Validates step belongs to the outcome in the URL param,
 * and that the outcome belongs to the user's org.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: outcomeId } = await params
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
  const { step_id, input_value } = body

  if (!step_id || input_value === undefined) {
    return NextResponse.json({ error: 'step_id and input_value required' }, { status: 400 })
  }

  // Validate step belongs to the outcome ID in the URL and to the user's org
  const valid = await validateStepBelongsToOutcome(step_id, outcomeId, profile.org_id)
  if (!valid) {
    return NextResponse.json(
      { error: 'Step not found or does not belong to this outcome' },
      { status: 404 }
    )
  }

  const ok = await updateStep(step_id, {
    status: 'pending', // Back to pending so executor picks it up
    blockerType: null,
    oneClearAsk: null,
    resultData: { user_input: input_value },
  }, profile.org_id)

  if (!ok) return NextResponse.json({ error: 'Failed to resolve step' }, { status: 500 })
  return NextResponse.json({ success: true })
}
