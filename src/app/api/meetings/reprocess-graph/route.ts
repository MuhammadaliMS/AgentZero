import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runExtractionPipeline } from '@/lib/graph/extraction-pipeline'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/meetings/reprocess-graph
 *
 * Re-run knowledge graph extraction on an existing meeting's summary.
 * Use this to populate graph entities for meetings where the extraction
 * pipeline was missed (e.g. due to FK violations or Vercel timeouts).
 *
 * Body: { meeting_id: string }
 * Auth: Requires authenticated user OR Bearer CRON_SECRET.
 */
export async function POST(request: NextRequest) {
  // Auth: accept either user session or CRON_SECRET Bearer token
  let authed = false

  // Check Bearer token (CRON_SECRET) for automated/CLI calls
  const authHeader = request.headers.get('authorization') ?? ''
  if (process.env.CRON_SECRET && authHeader.startsWith('Bearer ')) {
    const expected = `Bearer ${process.env.CRON_SECRET}`
    if (
      authHeader.length === expected.length &&
      timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
    ) {
      authed = true
    }
  }

  // Fallback to user session auth
  if (!authed) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    authed = true
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

  const admin = createAdminClient() as any

  // Fetch meeting with summary
  const { data: meeting } = await admin
    .from('meetings')
    .select('id, org_id, title, participants, status, summary_ready')
    .eq('id', body.meeting_id)
    .single()

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  if (!meeting.summary_ready) {
    return NextResponse.json({
      error: 'Meeting has no summary yet — summarize first',
    }, { status: 422 })
  }

  // Fetch summary
  const { data: summary } = await admin
    .from('meeting_summaries')
    .select('tldr, executive_summary')
    .eq('meeting_id', body.meeting_id)
    .single()

  // Fetch action items
  const { data: actionItems } = await admin
    .from('meeting_action_items')
    .select('action, owner_name, owner_email, due_date, priority')
    .eq('meeting_id', body.meeting_id)

  // Fetch decisions
  const { data: decisions } = await admin
    .from('meeting_decisions')
    .select('decision, decided_by, rationale, stakeholders')
    .eq('meeting_id', body.meeting_id)

  // Fetch transcript excerpt
  const { data: segments } = await admin
    .from('transcript_segments')
    .select('speaker, text, start_time')
    .eq('meeting_id', body.meeting_id)
    .eq('is_final', true)
    .order('start_time', { ascending: true })
    .limit(200)

  const transcript = segments
    ?.map((s: { speaker: string; text: string; start_time: number }) =>
      `${s.speaker || 'Unknown'} [${Math.floor((s.start_time || 0) / 60)}:${String(Math.floor((s.start_time || 0) % 60)).padStart(2, '0')}]: ${s.text}`
    )
    .join('\n') || ''

  const participants = (meeting.participants as Array<{ name: string; email: string }>) || []

  // Build extraction content (same format as meeting-processor)
  const lines = [
    `Meeting: ${meeting.title}`,
    `Summary: ${summary?.tldr || 'No summary'}`,
    '',
    summary?.executive_summary || '',
    '',
  ]

  if (participants.length > 0) {
    lines.push('## Participants')
    for (const p of participants) {
      lines.push(`- ${p.name} (email: ${p.email})`)
    }
    lines.push('')
  }

  for (const item of (actionItems || [])) {
    lines.push(`Action item: ${item.action} (owner: ${item.owner_name}${item.owner_email ? `, email: ${item.owner_email}` : ''}, due: ${item.due_date || 'unset'}, priority: ${item.priority})`)
  }

  for (const d of (decisions || [])) {
    lines.push(`Decision: ${d.decision} (by: ${d.decided_by}, rationale: ${d.rationale || 'none'})`)
  }

  lines.push('\n## Transcript Excerpt')
  lines.push(transcript.slice(0, 8000))

  const graphContent = lines.join('\n')

  // Run extraction pipeline (awaited)
  const startTime = Date.now()
  await runExtractionPipeline({
    orgId: meeting.org_id,
    conversationId: null,
    messageContent: graphContent,
    role: 'assistant',
  })

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startTime,
    message: `Knowledge graph extraction completed for "${meeting.title}"`,
    contentLength: graphContent.length,
  })
}
