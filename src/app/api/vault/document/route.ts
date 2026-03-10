import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const path = request.nextUrl.searchParams.get('path')

    if (!path) {
      return NextResponse.json({ error: 'path required' }, { status: 400 })
    }

    const { data: document, error } = await admin
      .from('vault_documents')
      .select('*')
      .eq('org_id', orgId)
      .eq('path', path)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const { data: links } = await admin
      .from('vault_document_links')
      .select('link_kind, target_id')
      .eq('org_id', orgId)
      .eq('vault_document_id', document.id)

    return NextResponse.json({
      document,
      links: links ?? [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
