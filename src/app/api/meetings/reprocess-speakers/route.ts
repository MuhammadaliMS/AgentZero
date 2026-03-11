import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { attributeSpeakersIfNeeded } from '@/lib/intelligence/speaker-attribution'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/meetings/reprocess-speakers
 *
 * Re-run LLM speaker attribution on an existing meeting's transcript.
 * Use this to fix meetings where DOM speaker tracking failed and all
 * segments ended up with the same (or concatenated) speaker name.
 *
 * Body: { meeting_id: string, async?: boolean }
 * Auth: Requires authenticated user OR Bearer CRON_SECRET for admin use.
 *
 * When async=true (or admin auth), returns immediately and runs in background.
 */
export async function POST(request: NextRequest) {
  let body: { meeting_id: string; async?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.meeting_id) {
    return NextResponse.json({ error: 'meeting_id required' }, { status: 400 })
  }

  // Auth: check CRON_SECRET first (admin), then fall back to user auth
  const authHeader = request.headers.get('authorization') ?? ''
  const cronSecret = process.env.CRON_SECRET
  let isAdmin = false

  if (cronSecret && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    if (
      token.length === cronSecret.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))
    ) {
      isAdmin = true
    }
  }

  if (!isAdmin) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Verify user has access to this meeting (through org membership)
    const { data: meeting } = await (supabase as any)
      .from('meetings')
      .select('id, org_id, title')
      .eq('id', body.meeting_id)
      .single()

    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
    }

    const { data: membership } = await (supabase as any)
      .from('organization_members')
      .select('id')
      .eq('org_id', meeting.org_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 })
    }
  }

  const useAsync = body.async === true || (isAdmin && body.async !== false)

  if (useAsync) {
    // Return immediately, run in background (up to maxDuration)
    waitUntil((async () => {
      try {
        const result = await attributeSpeakersIfNeeded(body.meeting_id)
        console.log(`[reprocess-speakers] ${body.meeting_id}: done`, result)
      } catch (err) {
        console.error(`[reprocess-speakers] ${body.meeting_id}: error`, (err as Error).message)
      }
    })())

    return NextResponse.json({
      ok: true,
      status: 'accepted',
      message: 'Speaker attribution started in background',
    })
  }

  // Synchronous — wait for result
  const result = await attributeSpeakersIfNeeded(body.meeting_id)

  if (!result) {
    return NextResponse.json({
      ok: true,
      message: 'Speakers already attributed — no changes needed',
    })
  }

  return NextResponse.json({
    ok: true,
    attributed: result.attributed,
    speakers: result.speakers,
    durationMs: result.durationMs,
    message: result.attributed > 0
      ? `Attributed ${result.attributed} segments to ${result.speakers.length} speakers: ${result.speakers.join(', ')}`
      : 'Could not attribute speakers',
  })
}
