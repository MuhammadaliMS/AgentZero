import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider, hasProvider } from '@/lib/integrations/registry'
import { TokenManager } from '@/lib/integrations/token-manager'

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

  try {
    const tokens = await TokenManager.getTokens(profile.org_id, key)
    if (!tokens) {
      return NextResponse.json({ healthy: false, error: 'Not connected' })
    }

    const provider = getProvider(key)
    const result = await provider.testConnection(tokens)

    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({
      healthy: false,
      error: (e as Error).message,
    })
  }
}
