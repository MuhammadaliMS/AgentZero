import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'

import {
  processNextEvidenceJob,
  triggerEvidenceJobProcessor,
} from '@/lib/evidence/jobs'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const requestedJobId = request.nextUrl.searchParams.get('job_id') ?? undefined

  waitUntil((async () => {
    const result = await processNextEvidenceJob(requestedJobId)
    if (result.hasPendingJobs) {
      await triggerEvidenceJobProcessor()
    }
  })())

  return NextResponse.json({
    ok: true,
    status: 'accepted',
    jobId: requestedJobId ?? null,
  })
}
