import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { AgentSDK } from '@/lib/agent/sdk-switch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── GET: Fetch the org's SDK preference ──────────────────────────────────────

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const { data: org } = await admin
    .from('organizations')
    .select('settings')
    .eq('id', profile.org_id)
    .single()

  const settings = (org?.settings || {}) as Record<string, unknown>
  const agentSdk = (settings.agent_sdk as AgentSDK) || 'claude'

  return NextResponse.json({ sdk: agentSdk })
}

// ─── PUT: Update the org's SDK preference ─────────────────────────────────────

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { sdk } = body as { sdk: string }

  if (sdk !== 'claude' && sdk !== 'openai') {
    return NextResponse.json(
      { error: 'Invalid SDK. Must be "claude" or "openai".' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  // Read current org settings, merge in the new SDK preference
  const { data: org } = await admin
    .from('organizations')
    .select('settings')
    .eq('id', profile.org_id)
    .single()

  const currentSettings = (org?.settings || {}) as Record<string, unknown>
  const updatedSettings = { ...currentSettings, agent_sdk: sdk }

  const { error } = await admin
    .from('organizations')
    .update({ settings: updatedSettings })
    .eq('id', profile.org_id)

  if (error) {
    return NextResponse.json({ error: 'Failed to update SDK preference' }, { status: 500 })
  }

  return NextResponse.json({ sdk })
}
