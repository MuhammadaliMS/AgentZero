import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { processMeeting } from '@/lib/intelligence/meeting-processor'
import { sendMeetingNotification } from '@/lib/intelligence/meeting-notification'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Webhook: Meeting Completed
 *
 * Called by the VPS bot service when:
 * 1. Bot leaves a meeting (recording done)
 * 2. Transcription is finished (WhisperX / Deepgram results written to DB)
 *
 * The VPS bot writes transcript_segments directly to Supabase via service key,
 * then hits this webhook to trigger AI summarization.
 *
 * Authentication: Bearer token using CRON_SECRET (same key used for cron jobs).
 * The VPS bot sets this in its env as WEBHOOK_AUTH_TOKEN.
 */
export async function POST(request: NextRequest) {
  // Auth check — same pattern as cron routes
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

  // Parse body
  let body: {
    meeting_id: string
    event: 'recording_complete' | 'transcription_complete' | 'bot_error'
    recording_path?: string
    recording_size_bytes?: number
    duration_seconds?: number
    segment_count?: number
    error_message?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.meeting_id) {
    return NextResponse.json({ error: 'meeting_id required' }, { status: 400 })
  }

  const admin = createAdminClient() as any // meeting tables not in generated types yet

  // Verify meeting exists
  const { data: meeting, error: meetingErr } = await admin
    .from('meetings')
    .select('id, status, org_id')
    .eq('id', body.meeting_id)
    .single()

  if (meetingErr || !meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  switch (body.event) {
    case 'recording_complete': {
      // Bot left the meeting, audio recorded. Update metadata.
      await admin
        .from('meetings')
        .update({
          status: 'transcribing',
          actual_end: new Date().toISOString(),
          duration_seconds: body.duration_seconds ?? null,
          recording_path: body.recording_path ?? null,
          recording_size_bytes: body.recording_size_bytes ?? null,
        })
        .eq('id', body.meeting_id)

      console.log(`[webhook/meeting-completed] Recording complete for ${body.meeting_id}`)

      return NextResponse.json({
        ok: true,
        status: 'transcribing',
        message: 'Meeting updated. VPS should now run transcription and call back with transcription_complete.',
      })
    }

    case 'transcription_complete': {
      // Verify transcript segments actually exist before triggering summarization
      const { count: segmentCount } = await admin
        .from('transcript_segments')
        .select('id', { count: 'exact', head: true })
        .eq('meeting_id', body.meeting_id)
        .eq('is_final', true)

      if (!segmentCount || segmentCount === 0) {
        console.error(`[webhook/meeting-completed] transcription_complete received but 0 segments in DB for ${body.meeting_id}`)
        await admin
          .from('meetings')
          .update({
            status: 'failed',
            error_message: 'Transcription reported complete but no segments found in database',
          })
          .eq('id', body.meeting_id)
        return NextResponse.json({
          ok: false,
          status: 'failed',
          message: 'No transcript segments found in database despite transcription_complete event.',
        }, { status: 422 })
      }

      // Transcript segments confirmed in DB. Trigger AI summarization.
      await admin
        .from('meetings')
        .update({
          status: 'processing',
          transcript_ready: true,
        })
        .eq('id', body.meeting_id)

      console.log(`[webhook/meeting-completed] ${segmentCount} segments confirmed for ${body.meeting_id} — triggering summarization`)

      // Run summarization in background (don't block webhook response)
      waitUntil(
        processMeeting(body.meeting_id).then(async (result) => {
          console.log(
            `[webhook/meeting-completed] Summarization ${result.status} for ${body.meeting_id}: ` +
            `${result.actionItemsCount} actions, ${result.decisionsCount} decisions (${result.durationMs}ms)`
          )
          // Send Slack notification after successful summarization
          if (result.status === 'completed') {
            try {
              await sendMeetingNotification(body.meeting_id)
            } catch (notifErr) {
              console.error(`[webhook/meeting-completed] Notification failed for ${body.meeting_id}:`, notifErr)
            }
          }
        }).catch(err => {
          console.error(`[webhook/meeting-completed] Summarization failed for ${body.meeting_id}:`, err)
        })
      )

      return NextResponse.json({
        ok: true,
        status: 'processing',
        message: 'Summarization triggered. Meeting will be marked completed when done.',
      })
    }

    case 'bot_error': {
      // Bot hit an error — log it
      await admin
        .from('meetings')
        .update({
          status: 'failed',
          error_message: body.error_message?.slice(0, 500) ?? 'Unknown bot error',
          retry_count: (meeting as Record<string, unknown>).retry_count
            ? ((meeting as Record<string, unknown>).retry_count as number) + 1
            : 1,
        })
        .eq('id', body.meeting_id)

      console.error(
        `[webhook/meeting-completed] Bot error for ${body.meeting_id}: ${body.error_message}`
      )

      return NextResponse.json({
        ok: true,
        status: 'failed',
        message: 'Error recorded.',
      })
    }

    default:
      return NextResponse.json(
        { error: `Unknown event type: ${body.event}` },
        { status: 400 }
      )
  }
}
