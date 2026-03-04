import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveNarratives, upsertNarrative } from '@/lib/graph/strategic-memory'
import type { NarrativeType } from '@/lib/graph/strategic-memory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/narratives
 * List active strategic narratives.
 * Query params: type?, limit?
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const narrativeType = searchParams.get('type') as NarrativeType | null
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)

  const narratives = await getActiveNarratives(profile.org_id, {
    narrativeType: narrativeType ?? undefined,
    limit,
  })

  return NextResponse.json({ narratives, total: narratives.length })
}

/**
 * POST /api/agent/narratives
 * Create or update a strategic narrative.
 */
export async function POST(request: NextRequest) {
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

  const id = await upsertNarrative({
    orgId: profile.org_id,
    title: body.title,
    narrativeType: body.narrative_type,
    summary: body.summary,
    keyFacts: body.key_facts,
    decisionHistory: body.decision_history,
    priorOutcomes: body.prior_outcomes,
    openQuestions: body.open_questions,
    relatedEntityIds: body.related_entity_ids,
    relatedOutcomeIds: body.related_outcome_ids,
    lastUpdatedBy: 'manual',
  })

  if (!id) return NextResponse.json({ error: 'Failed to upsert narrative' }, { status: 500 })
  return NextResponse.json({ id }, { status: 201 })
}
