import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runExtractionPipeline } from '@/lib/graph/extraction-pipeline'
import { runEvidencePipeline } from '@/lib/evidence/pipeline'
import { isFeatureEnabled } from '@/lib/evidence/flags'

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
    .select('id, org_id, title, participants, status, summary_ready, scheduled_start, actual_end, meeting_url')
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

  const { data: orgRow } = await admin
    .from('organizations')
    .select('settings')
    .eq('id', meeting.org_id)
    .maybeSingle()
  const orgSettings = (orgRow?.settings || {}) as Record<string, unknown>

  // Fetch summary
  const { data: summary } = await admin
    .from('meeting_summaries')
    .select('tldr, executive_summary, detailed_summary, topics')
    .eq('meeting_id', body.meeting_id)
    .single()

  // Fetch action items
  const { data: actionItems } = await admin
    .from('meeting_action_items')
    .select('action, owner_name, owner_email, due_date, priority, context_quote')
    .eq('meeting_id', body.meeting_id)

  // Fetch decisions
  const { data: decisions } = await admin
    .from('meeting_decisions')
    .select('decision, decided_by, rationale, stakeholders, context_quote')
    .eq('meeting_id', body.meeting_id)

  // Fetch full transcript segments
  const { data: segments } = await admin
    .from('transcript_segments')
    .select('id, speaker, text, start_time, end_time, created_at')
    .eq('meeting_id', body.meeting_id)
    .eq('is_final', true)
    .order('start_time', { ascending: true })

  // Run extraction pipeline (awaited)
  const startTime = Date.now()
  if (isFeatureEnabled('evidence_graph_v2', orgSettings)) {
    await runEvidencePipeline({
      orgId: meeting.org_id,
      source: {
        kind: 'meeting',
        meeting,
        segments: segments || [],
        summary: summary
          ? {
            tldr: summary.tldr,
            executive_summary: summary.executive_summary,
            detailed_summary: summary.detailed_summary,
            topics: summary.topics,
          }
          : null,
        actionItems: (actionItems || []).map((item: {
          action: string
          owner_name: string | null
          owner_email: string | null
          due_date: string | null
          priority: string | null
          context_quote: string | null
        }) => ({
          action: item.action,
          owner: item.owner_name,
          owner_email: item.owner_email,
          due_date: item.due_date,
          priority: item.priority,
          context_quote: item.context_quote,
        })),
        decisions: (decisions || []).map((decision: {
          decision: string
          decided_by: string | null
          rationale: string | null
          stakeholders: unknown
          context_quote: string | null
        }) => ({
          decision: decision.decision,
          decided_by: decision.decided_by,
          rationale: decision.rationale,
          stakeholders: decision.stakeholders,
          context_quote: decision.context_quote,
        })),
      },
    })
  } else {
    const transcript = segments
      ?.map((s: { speaker: string; text: string; start_time: number }) =>
        `${s.speaker || 'Unknown'} [${Math.floor((s.start_time || 0) / 60)}:${String(Math.floor((s.start_time || 0) % 60)).padStart(2, '0')}]: ${s.text}`
      )
      .join('\n') || ''
    const participants = (meeting.participants as Array<{ name: string; email: string }>) || []
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

    await runExtractionPipeline({
      orgId: meeting.org_id,
      conversationId: null,
      messageContent: lines.join('\n'),
      role: 'assistant',
    })
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startTime,
    message: `Knowledge graph extraction completed for "${meeting.title}"`,
    evidenceItems: segments?.length ?? 0,
  })
}
