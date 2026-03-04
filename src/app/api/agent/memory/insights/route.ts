import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/memory/insights
 *
 * List active insights for the user's org (UI dashboard).
 * Supports optional filters: ?type=contradiction&status=active
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
  const insightType = url.searchParams.get('type')
  const status = url.searchParams.get('status') ?? 'active'
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100)

  let query = supabase
    .from('graph_insights')
    .select('id, insight_type, category, summary, confidence, utility_score, related_entity_ids, status, times_triggered, last_triggered_at, expires_at, created_at')
    .eq('org_id', profile.org_id)
    .order('confidence', { ascending: false })
    .limit(limit)

  if (status !== 'all') {
    query = query.eq('status', status)
  }

  if (insightType) {
    query = query.eq('insight_type', insightType)
  }

  const { data: insights, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ insights: insights ?? [], count: insights?.length ?? 0 })
}
