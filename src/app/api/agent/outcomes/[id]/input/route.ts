import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateStep, updateOutcomeStatus, validateStepBelongsToOutcome } from '@/lib/agent/runtime/outcome-runtime'

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

  // ── Step state guard ──────────────────────────────────────────────────
  // Only allow completing steps that are actually blocked and waiting for
  // user input or approval. Prevents completing already-completed, failed,
  // or tool_call steps via this endpoint.
  const admin = createAdminClient()
  const { data: step } = await admin
    .from('outcome_steps')
    .select('status, action_type, blocker_type')
    .eq('id', step_id)
    .eq('org_id', profile.org_id)
    .single()

  if (!step) {
    return NextResponse.json({ error: 'Step not found' }, { status: 404 })
  }

  if (step.status !== 'blocked') {
    return NextResponse.json(
      { error: `Step is not blocked (current status: ${step.status})` },
      { status: 409 }
    )
  }

  if (step.blocker_type !== 'input_needed' && step.blocker_type !== 'approval_pending') {
    return NextResponse.json(
      { error: `Step blocker type '${step.blocker_type}' cannot be resolved via input` },
      { status: 409 }
    )
  }

  // Mark the wait_input/wait_approval step as completed (input IS the result)
  const ok = await updateStep(step_id, {
    status: 'completed',
    blockerType: null,
    oneClearAsk: null,
    resultSummary: typeof input_value === 'string' ? input_value : JSON.stringify(input_value),
    resultData: { user_input: input_value },
  }, profile.org_id)

  if (!ok) return NextResponse.json({ error: 'Failed to resolve step' }, { status: 500 })

  // Re-enter execution: set outcome back to 'executing' so background runner picks it up.
  // Also clear blocker summary since the blocker is resolved.
  try {
    await updateOutcomeStatus(outcomeId, 'executing', {
      orgId: profile.org_id,
      blockerSummary: undefined,
    })
  } catch {
    // Non-fatal — outcome status update is best-effort
  }

  return NextResponse.json({ success: true })
}
