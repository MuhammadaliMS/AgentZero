import { NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const { data, error } = await admin
      .from('vault_documents')
      .select('id, path, title, document_type, render_strategy, updated_at, last_source_update_at, staleness_reason')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false })
      .limit(30)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      changes: data ?? [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
