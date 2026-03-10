import { NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'
import { buildVaultTree } from '@/lib/evidence/vault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const { data, error } = await admin
      .from('vault_documents')
      .select('path')
      .eq('org_id', orgId)
      .order('path', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const paths = (data ?? []).map((row: Record<string, unknown>) => String(row.path ?? '')).filter(Boolean)
    return NextResponse.json({
      tree: buildVaultTree(paths),
      total: paths.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
