import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getRolloutConfig, evaluateRolloutAdvancement } from '@/lib/agent/runtime/rollout-manager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/rollout
 * Get current rollout configuration and recent measurements.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const config = await getRolloutConfig(profile.org_id)

  // Get recent measurements
  const { data: measurements } = await supabase
    .from('rollout_measurement')
    .select('*')
    .eq('org_id', profile.org_id)
    .order('measurement_week', { ascending: false })
    .limit(8)

  return NextResponse.json({
    config,
    measurements: measurements ?? [],
  })
}

/**
 * POST /api/agent/rollout/evaluate
 * Trigger rollout advancement evaluation.
 * Requires explicit { confirm: true } body — rollout mode changes are security-critical.
 * TODO: Gate to org-admin role once RBAC is implemented.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  // Require explicit confirmation — prevents accidental mode changes
  let body: { confirm?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // No body or invalid JSON
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: 'Rollout evaluation requires { "confirm": true } in request body' },
      { status: 400 }
    )
  }

  console.log(`[Rollout] Evaluation triggered by user ${user.id} for org ${profile.org_id}`)

  const result = await evaluateRolloutAdvancement(profile.org_id)
  return NextResponse.json(result)
}
