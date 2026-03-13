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
      .select('path, title, document_type, updated_at, last_source_update_at, sections, manual_sections')
      .eq('org_id', orgId)
      .order('path', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const documents = ((data ?? []) as Array<Record<string, unknown>>)
      .map((row) => {
        const sections = Array.isArray(row.sections)
          ? row.sections as Array<Record<string, unknown>>
          : []
        const summarySection = sections.find((section) =>
          section.kind === 'summary' || section.kind === 'narrative' || section.kind === 'changes'
        )
        const manualSections = (row.manual_sections ?? {}) as Record<string, { content?: string }>

        return {
          path: String(row.path ?? ''),
          title: String(row.title ?? ''),
          documentType: String(row.document_type ?? ''),
          updatedAt: String(row.updated_at ?? ''),
          lastSourceUpdateAt: typeof row.last_source_update_at === 'string' ? row.last_source_update_at : null,
          summary: typeof summarySection?.content === 'string' ? summarySection.content : null,
          manualSectionSummaries: Object.values(manualSections)
            .map((section) => typeof section?.content === 'string' ? section.content.trim() : '')
            .filter(Boolean)
            .slice(0, 3),
        }
      })
      .filter((row) => row.path.length > 0)
    const paths = documents.map((row) => row.path)
    const recentlyChanged = [...documents]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    const accounts = documents
      .filter((doc) => doc.path.startsWith('Narratives/Accounts/') || doc.path.startsWith('Knowledge/Organizations/'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    const relationships = documents
      .filter((doc) => doc.path.startsWith('Narratives/Relationships/'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    const meetings = documents
      .filter((doc) => doc.path.startsWith('Sources/Meetings/'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    const work = documents
      .filter((doc) => doc.path.startsWith('Work/') || doc.path.startsWith('Briefs/'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
    const jumpBackIn = documents
      .filter((doc) => doc.path.startsWith('Briefs/') || doc.path.startsWith('Narratives/'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)

    return NextResponse.json({
      tree: buildVaultTree(paths),
      total: paths.length,
      entryPoints: {
        accounts,
        relationships,
        meetings,
        work,
        jumpBackIn,
        recentlyChanged,
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
