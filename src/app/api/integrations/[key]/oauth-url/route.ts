import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider, hasProvider } from '@/lib/integrations/registry'
import { encrypt } from '@/lib/utils/crypto'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!hasProvider(key)) {
    return NextResponse.json({ error: 'Unknown integration' }, { status: 404 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const provider = getProvider(key)
  // Provider code is the authoritative source for scopes.
  // Never use DB manifest.default_scopes — it goes stale after code updates.
  const scopes = provider.getDefaultScopes()

  // Encrypt state parameter
  const statePayload = JSON.stringify({
    key,
    org_id: profile.org_id,
    user_id: user.id,
    redirect_to: new URL(request.url).searchParams.get('redirect_to') || '/onboarding',
    timestamp: Date.now(),
  })
  const state = encrypt(statePayload)

  let authUrl: string
  try {
    authUrl = await provider.getAuthUrl(scopes, state)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build authorization URL'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  return NextResponse.json({ url: authUrl })
}
