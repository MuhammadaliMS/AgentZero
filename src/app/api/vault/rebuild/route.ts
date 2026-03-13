import { waitUntil } from '@vercel/functions'
import { NextRequest, NextResponse } from 'next/server'

import { getAuthenticatedEvidenceContext } from '@/lib/evidence/auth'
import { rebuildVaultWorkspace } from '@/lib/evidence/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const { orgId, admin } = await getAuthenticatedEvidenceContext()
    const body = await request.json().catch(() => ({}))
    const synchronous = Boolean(body?.synchronous)
    const pruneMissing = body?.pruneMissing !== false
    const artifactLimit = typeof body?.artifactLimit === 'number' ? body.artifactLimit : undefined

    if (synchronous) {
      const result = await rebuildVaultWorkspace(admin, {
        orgId,
        pruneMissing,
        artifactLimit,
      })

      return NextResponse.json({
        ok: true,
        status: 'completed',
        ...result,
      })
    }

    waitUntil((async () => {
      await rebuildVaultWorkspace(admin, {
        orgId,
        pruneMissing,
        artifactLimit,
      })
    })())

    return NextResponse.json({
      ok: true,
      status: 'accepted',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthorized' ? 401 : 500 }
    )
  }
}
