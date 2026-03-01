import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider, hasProvider } from '@/lib/integrations/registry'
import { TokenManager } from '@/lib/integrations/token-manager'

export const dynamic = 'force-dynamic'

export async function POST(
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

  try {
    const body = await request.json()
    const provider = getProvider(key)

    // For API key integrations, handleCallback accepts JSON-encoded credentials
    const tokens = await provider.handleCallback(JSON.stringify(body), '')

    // Test the connection
    const health = await provider.testConnection({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
    })

    if (!health.healthy) {
      return NextResponse.json(
        { error: `Connection test failed: ${health.error}` },
        { status: 400 }
      )
    }

    // Get integration ID
    const admin = createAdminClient()
    const { data: integration } = await admin
      .from('integrations')
      .select('id')
      .eq('key', key)
      .single()

    if (!integration) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    }

    // Store tokens
    await TokenManager.storeTokens(
      profile.org_id,
      integration.id,
      tokens,
      [],
      user.id,
      tokens.raw as Record<string, unknown> | undefined
    )

    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 400 }
    )
  }
}
