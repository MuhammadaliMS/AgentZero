import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildAssociativeContext } from '@/lib/graph/associative-recall'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/memory/context-pack?message=...
 *
 * Debug endpoint: show what context pack would be injected for a test message.
 */
export async function GET(request: Request) {
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

  const url = new URL(request.url)
  const message = url.searchParams.get('message')

  if (!message) {
    return NextResponse.json({ error: 'message query param required' }, { status: 400 })
  }

  const result = await buildAssociativeContext(profile.org_id, message)

  if (!result) {
    return NextResponse.json({
      message: 'No matching entities found',
      contextBlock: null,
    })
  }

  return NextResponse.json({
    contextBlock: result.contextBlock,
    matchedEntityIds: result.matchedEntityIds,
    itemCount: result.itemCount,
    budgetUsed: result.budgetUsed,
    durationMs: result.durationMs,
  })
}
