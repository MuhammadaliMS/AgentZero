import { createUntypedAdminClient } from '@/lib/supabase/admin'
import { runEvidencePipeline } from '@/lib/evidence/pipeline'

const supabase = createUntypedAdminClient()
const limit = Number(process.env.BACKFILL_LIMIT ?? '25')
const meetingsOnly = process.argv.includes('--meetings-only')
const chatsOnly = process.argv.includes('--chats-only')

async function main() {
  let meetingsProcessed = 0
  let chatsProcessed = 0

  if (!chatsOnly) {
    meetingsProcessed = await backfillMeetings()
  }

  if (!meetingsOnly) {
    chatsProcessed = await backfillChats()
  }

  console.log(JSON.stringify({
    ok: true,
    meetingsProcessed,
    chatsProcessed,
  }, null, 2))
}

async function backfillMeetings(): Promise<number> {
  const { data: meetings, error } = await supabase
    .from('meetings')
    .select('id, org_id, title, participants, summary_ready, scheduled_start, actual_end, meeting_url')
    .eq('summary_ready', true)
    .order('scheduled_start', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to fetch meetings: ${error.message}`)
  }

  let processed = 0

  for (const meeting of meetings ?? []) {
    const [{ data: segments }, { data: summary }, { data: actionItems }, { data: decisions }] = await Promise.all([
      supabase
        .from('transcript_segments')
        .select('id, speaker, text, start_time, end_time, created_at')
        .eq('meeting_id', meeting.id)
        .eq('is_final', true)
        .order('start_time', { ascending: true }),
      supabase
        .from('meeting_summaries')
        .select('tldr, executive_summary, detailed_summary, topics')
        .eq('meeting_id', meeting.id)
        .maybeSingle(),
      supabase
        .from('meeting_action_items')
        .select('action, owner_name, owner_email, due_date, priority, context_quote')
        .eq('meeting_id', meeting.id),
      supabase
        .from('meeting_decisions')
        .select('decision, decided_by, rationale, stakeholders, context_quote')
        .eq('meeting_id', meeting.id),
    ])

    if (!segments || segments.length === 0) continue

    await runEvidencePipeline({
      orgId: meeting.org_id,
      source: {
        kind: 'meeting',
        meeting,
        segments,
        summary: summary
          ? {
            tldr: summary.tldr,
            executive_summary: summary.executive_summary,
            detailed_summary: summary.detailed_summary,
            topics: summary.topics,
          }
          : null,
        actionItems: (actionItems ?? []).map((item: {
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
        decisions: (decisions ?? []).map((decision: {
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

    processed++
    console.log(`[backfill-evidence] Meeting ${meeting.id} processed`)
  }

  return processed
}

async function backfillChats(): Promise<number> {
  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('id, org_id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to fetch conversations: ${error.message}`)
  }

  let processed = 0

  for (const conversation of conversations ?? []) {
    const { data: messages } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversation.id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20)

    if (!messages || messages.length === 0) continue

    await runEvidencePipeline({
      orgId: conversation.org_id,
      source: {
        kind: 'chat',
        conversation,
        messages,
      },
    })

    processed++
    console.log(`[backfill-evidence] Conversation ${conversation.id} processed`)
  }

  return processed
}

main().catch(error => {
  console.error('[backfill-evidence] Failed:', error)
  process.exit(1)
})
