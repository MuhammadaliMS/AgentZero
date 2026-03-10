import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { attributeSpeakersIfNeeded } from '@/lib/intelligence/speaker-attribution'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/meetings/reprocess-speakers
 *
 * Re-run LLM speaker attribution on an existing meeting's transcript.
 * Use this to fix meetings where DOM speaker tracking failed and all
 * segments ended up with the same (or concatenated) speaker name.
 *
 * Body: { meeting_id: string }
 * Auth: Requires authenticated user who belongs to the meeting's org.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { meeting_id: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.meeting_id) {
    return NextResponse.json({ error: 'meeting_id required' }, { status: 400 })
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

  // Verify org membership
  const { data: membership } = await (supabase as any)
    .from('organization_members')
    .select('id')
    .eq('org_id', meeting.org_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 })
  }

  // Run speaker attribution
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
