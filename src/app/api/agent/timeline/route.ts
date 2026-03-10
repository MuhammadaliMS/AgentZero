import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const entityId = request.nextUrl.searchParams.get('entity_id')
    const decisionThreadId = request.nextUrl.searchParams.get('decision_thread_id')
    const commitmentId = request.nextUrl.searchParams.get('commitment_id')
    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? '50'), 100)

    if (!entityId && !decisionThreadId && !commitmentId) {
      return NextResponse.json(
        { error: 'entity_id, decision_thread_id, or commitment_id required' },
        { status: 400 }
      )
    }

    if (entityId) {
      const { data: claims } = await admin
        .from('claims')
        .select('*')
        .eq('org_id', orgId)
        .or(`subject_entity_id.eq.${entityId},object_entity_id.eq.${entityId}`)
        .order('valid_from', { ascending: true })
        .limit(limit)

      return NextResponse.json({
        scope: 'entity',
        entityId,
        timeline: claims ?? [],
      })
    }

    if (decisionThreadId) {
      const { data: thread } = await admin
        .from('decision_threads')
        .select('*')
        .eq('org_id', orgId)
        .eq('id', decisionThreadId)
        .maybeSingle()

      if (!thread) {
        return NextResponse.json({ error: 'Decision thread not found' }, { status: 404 })
      }

      const relatedEntityIds = Array.isArray(thread.related_entity_ids) ? thread.related_entity_ids : []
      const { data: claims } = relatedEntityIds.length > 0
        ? await admin
          .from('claims')
          .select('*')
          .eq('org_id', orgId)
          .eq('claim_kind', 'decision')
          .in('subject_entity_id', relatedEntityIds)
          .order('valid_from', { ascending: true })
          .limit(limit)
        : { data: [] }

      return NextResponse.json({
        scope: 'decision_thread',
        decisionThread: thread,
        timeline: claims ?? [],
      })
    }

    const { data: commitment } = await admin
      .from('commitments')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', commitmentId)
      .maybeSingle()

    if (!commitment) {
      return NextResponse.json({ error: 'Commitment not found' }, { status: 404 })
    }

    const sourceClaimId = typeof commitment.source_claim_id === 'string'
      ? commitment.source_claim_id
      : null
    const { data: claims } = sourceClaimId
      ? await admin
        .from('claims')
        .select('*')
        .eq('org_id', orgId)
        .eq('id', sourceClaimId)
        .limit(1)
      : { data: [] }

    return NextResponse.json({
      scope: 'commitment',
      commitment,
      timeline: claims ?? [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
