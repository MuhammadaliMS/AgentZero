import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest) {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const body = await request.json() as {
      path?: string
      key?: string
      title?: string
      content?: string
    }

    if (!body.path || !body.key) {
      return NextResponse.json({ error: 'path and key are required' }, { status: 400 })
    }

    const { data: document } = await admin
      .from('vault_documents')
      .select('id, manual_sections, source_mode')
      .eq('org_id', orgId)
      .eq('path', body.path)
      .maybeSingle()

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    if (!['hybrid', 'manual'].includes(String(document.source_mode ?? 'generated'))) {
      return NextResponse.json({ error: 'Document does not support manual sections' }, { status: 422 })
    }

    const manualSections = (document.manual_sections && typeof document.manual_sections === 'object' && !Array.isArray(document.manual_sections))
      ? { ...(document.manual_sections as Record<string, unknown>) }
      : {}

    manualSections[body.key] = {
      key: body.key,
      title: body.title ?? body.key.replace(/_/g, ' '),
      content: body.content ?? '',
      updatedAt: new Date().toISOString(),
    }

    const { data: updated, error } = await admin
      .from('vault_documents')
      .update({
        manual_sections: manualSections,
        updated_at: new Date().toISOString(),
      })
      .eq('id', document.id)
      .select('id, path, manual_sections, updated_at')
      .single()

    if (error || !updated) {
      return NextResponse.json({ error: error?.message ?? 'Failed to update manual section' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      document: updated,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 500 }
    )
  }
}
