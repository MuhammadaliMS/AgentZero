import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'
import { fetchNamedVaultLinks } from '@/lib/evidence/store'

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

    const links = await fetchNamedVaultLinks(admin, orgId, document.id)
    const targetIds = [...new Set(links.map((link) => link.targetId))]

    let backlinks: Array<{
      targetId: string
      documentId: string
      path: string
      title: string
      documentType: string
      updatedAt: string
    }> = []
    if (targetIds.length > 0) {
      const { data: backlinkRows } = await admin
        .from('vault_document_links')
        .select('vault_document_id, target_id, vault_documents!inner(id, path, title, document_type, updated_at)')
        .eq('org_id', orgId)
        .in('target_id', targetIds)
        .neq('vault_document_id', document.id)

      backlinks = ((backlinkRows ?? []) as Array<Record<string, unknown>>)
        .map((row) => {
          const docRow = row.vault_documents as Record<string, unknown> | null
          if (!docRow) return null
          return {
            targetId: String(row.target_id ?? ''),
            documentId: String(docRow.id ?? ''),
            path: String(docRow.path ?? ''),
            title: String(docRow.title ?? ''),
            documentType: String(docRow.document_type ?? ''),
            updatedAt: String(docRow.updated_at ?? ''),
          }
        })
        .filter((row): row is {
          targetId: string
          documentId: string
          path: string
          title: string
          documentType: string
          updatedAt: string
        } => row !== null)
    }

    return NextResponse.json({
      document,
      links,
      backlinks,
      freshness: {
        stalenessReason: document.staleness_reason ?? null,
        lastSourceUpdateAt: document.last_source_update_at ?? null,
        updatedAt: document.updated_at ?? null,
      },
      compare: {
        previousSummary: (document.metadata as Record<string, unknown> | null)?.previousSummary ?? null,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
