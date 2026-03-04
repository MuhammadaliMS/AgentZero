import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserPreferences, setUserPreferences } from '@/lib/intelligence/learning-loop'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/preferences
 * Get current user's learned/explicit preferences.
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

  const prefs = await getUserPreferences(profile.org_id, user.id)
  return NextResponse.json(prefs)
}

/**
 * PUT /api/agent/preferences
 * Set user preferences explicitly.
 */
export async function PUT(request: NextRequest) {
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
  const ok = await setUserPreferences(profile.org_id, user.id, {
    interventionTiming: body.intervention_timing,
    messageStyle: body.message_style,
    riskTolerance: body.risk_tolerance,
    escalationPreference: body.escalation_preference,
  })

  if (!ok) return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 })
  return NextResponse.json({ success: true })
}
