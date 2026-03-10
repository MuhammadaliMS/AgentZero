import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'
import { buildEvidenceContextPack, serializeContextPack } from '@/lib/evidence/context-pack'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { orgId } = await getAuthenticatedEvidenceContext()
    const query = request.nextUrl.searchParams.get('q')
    const artifactId = request.nextUrl.searchParams.get('artifact_id')

    if (!query) {
      return NextResponse.json({ error: 'q required' }, { status: 400 })
    }

    const contextPack = await buildEvidenceContextPack({
      orgId,
      searchText: query,
      artifactId,
    })

    return NextResponse.json({
      ...contextPack,
      serialized: serializeContextPack(contextPack),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 404 }
    )
  }
}
