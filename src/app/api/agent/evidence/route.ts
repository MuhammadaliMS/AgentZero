import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const artifactId = request.nextUrl.searchParams.get('artifact_id')
    const entityId = request.nextUrl.searchParams.get('entity_id')
    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? '25'), 100)

    if (!artifactId && !entityId) {
      return NextResponse.json({ error: 'artifact_id or entity_id required' }, { status: 400 })
    }

    if (artifactId) {
      const { data: evidenceItems } = await admin
        .from('evidence_items')
        .select('*')
        .eq('org_id', orgId)
        .eq('artifact_id', artifactId)
        .order('sequence_no', { ascending: true })
        .limit(limit)

      const { data: claims } = await admin
        .from('claims')
        .select('*')
        .eq('org_id', orgId)
        .eq('artifact_id', artifactId)
        .order('valid_from', { ascending: false })
        .limit(limit)

      return NextResponse.json({
        artifactId,
        evidenceItems: evidenceItems ?? [],
        claims: claims ?? [],
      })
    }

    const { data: claims } = await admin
      .from('claims')
      .select('*')
      .eq('org_id', orgId)
      .or(`subject_entity_id.eq.${entityId},object_entity_id.eq.${entityId}`)
      .order('valid_from', { ascending: false })
      .limit(limit)

    const claimIds = (claims ?? []).map((claim: Record<string, unknown>) => String(claim.id ?? '')).filter(Boolean)
    const { data: links } = claimIds.length > 0
      ? await admin
        .from('claim_evidence_links')
        .select('claim_id, evidence_item_id, link_type')
        .eq('org_id', orgId)
        .in('claim_id', claimIds)
      : { data: [] }

    const evidenceItemIds = [...new Set((links ?? []).map((link: Record<string, unknown>) => String(link.evidence_item_id ?? '')).filter(Boolean))]
    const { data: evidenceItems } = evidenceItemIds.length > 0
      ? await admin
        .from('evidence_items')
        .select('*')
        .eq('org_id', orgId)
        .in('id', evidenceItemIds)
      : { data: [] }

    return NextResponse.json({
      entityId,
      claims: claims ?? [],
      links: links ?? [],
      evidenceItems: evidenceItems ?? [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
