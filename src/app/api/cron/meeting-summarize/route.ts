import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { expireStaleMeetings, processAllPendingMeetings } from '@/lib/intelligence/meeting-processor'
import { sendMeetingNotification } from '@/lib/intelligence/meeting-notification'
import { logCronRun, type ExecutionStep } from '@/lib/observability/cron-logger'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Cron: Meeting Summarize
 *
 * Polls for meetings in 'processing' / 'transcribing' status (and 'joining'
 * with transcript_ready=true as a safety net) and runs the AI summarization
 * pipeline. Same pattern as morning-brief:
 * responds immediately, heavy work runs via waitUntil.
 *
 * Schedule: Every 2 minutes (or triggered via webhook for immediate processing).
 */
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

  waitUntil(runMeetingSummarizeBackground())

  return NextResponse.json({ ok: true, status: 'accepted' })
}

async function runMeetingSummarizeBackground() {
  await logCronRun({ worker: 'meeting-summarize' }, async () => {
    const staleCleanup = await expireStaleMeetings()

    // 1. Process all pending meetings
    const { processed, succeeded, failed, results } = await processAllPendingMeetings()

    if (processed === 0 && staleCleanup.expired === 0) {
      return { summary: 'No pending meetings to process' }
    }

    console.log(
      `[meeting-summarize] Processed ${processed} meetings: ` +
      `${succeeded} succeeded, ${failed} failed`
    )

    // Build execution steps from processing results
    const steps: ExecutionStep[] = results.map((r) => ({
      ts: new Date().toISOString(),
      type: 'llm_call' as const,
      name: 'meeting-summarize',
      status: r.status === 'completed' ? ('ok' as const) : ('error' as const),
      duration_ms: r.durationMs,
      output: r.summary?.tldr?.slice(0, 300),
      error: r.error?.slice(0, 300),
    }))

    // 2. Send Slack notifications for completed meetings
    let notified = 0
    for (const result of results) {
      if (result.status !== 'completed') continue

      try {
        await sendMeetingNotification(result.meetingId)
        notified++
      } catch (err) {
        console.error(
          `[meeting-summarize] Notification failed for ${result.meetingId}:`,
          (err as Error).message
        )
      }
    }

    return {
      summary: `Processed ${processed} meetings: ${succeeded} succeeded, ${failed} failed, ${notified} notified, ${staleCleanup.expired} stale expired`,
      metrics: { processed, succeeded, failed, notified, staleExpired: staleCleanup.expired },
      steps,
    }
  })
}
