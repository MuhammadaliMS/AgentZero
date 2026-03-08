// ─── Meeting Summarization Pipeline ─────────────────────────────────────────
// Post-meeting AI processing: transcript → Claude → summaries, action items,
// decisions. Feeds results into knowledge graph, commitments, and memory.
//
// Pattern: Same as morning brief + extraction pipeline.
// Trigger: Called from /api/cron/meeting-summarize or /api/webhooks/meeting-completed.
// Never throws — catches all errors, logs them, marks meeting as failed.

import { createAdminClient } from '@/lib/supabase/admin'
import { runExtractionPipeline } from '@/lib/graph/extraction-pipeline'
import type { Json } from '@/types/database'
import { randomUUID } from 'crypto'

// ─── Types ───────────────────────────────────────────────────────────────

interface MeetingSummaryResult {
  tldr: string
  executive_summary: string
  detailed_summary: string
  topics: string[]
  action_items: Array<{
    action: string
    owner: string
    due_date: string | null
    priority: 'P0' | 'P1' | 'P2' | 'P3'
    context_quote: string
  }>
  decisions: Array<{
    decision: string
    rationale: string
    decided_by: string
    stakeholders: string[]
    context_quote: string
  }>
}

interface ProcessingResult {
  meetingId: string
  status: 'completed' | 'failed'
  summary?: { tldr: string }
  actionItemsCount: number
  decisionsCount: number
  durationMs: number
  error?: string
}

// ─── Config ──────────────────────────────────────────────────────────────

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const LLM_API_KEY = NVIDIA_API_KEY || OPENROUTER_API_KEY
const LLM_BASE_URL = process.env.LLM_BASE_URL || (NVIDIA_API_KEY
  ? 'https://integrate.api.nvidia.com/v1'
  : 'https://openrouter.ai/api/v1')
const DEFAULT_SUMMARIZATION_MODEL = process.env.MEETING_SUMMARY_MODEL || (NVIDIA_API_KEY
  ? 'qwen/qwen3.5-397b-a17b'
  : 'anthropic/claude-haiku-4.5')
const MAX_RETRIES = 3

// ─── System Prompt ───────────────────────────────────────────────────────

const MEETING_SUMMARY_SYSTEM_PROMPT = `You are a meeting analysis assistant for a senior product manager. Given a meeting transcript with speaker labels and timestamps, extract structured information.

Respond ONLY with valid JSON matching this exact schema:

{
  "tldr": "1-2 sentence summary of the meeting's main outcome",
  "executive_summary": "3-5 bullet points in markdown (use - prefix)",
  "detailed_summary": "Full narrative summary in markdown (3-6 paragraphs)",
  "topics": ["topic1", "topic2"],
  "action_items": [
    {
      "action": "What needs to be done",
      "owner": "Person responsible (from transcript)",
      "due_date": "Explicit date or relative ('by Friday', 'next sprint') or null",
      "priority": "P0|P1|P2|P3",
      "context_quote": "Brief transcript excerpt that sourced this"
    }
  ],
  "decisions": [
    {
      "decision": "What was decided",
      "rationale": "Why (1 sentence)",
      "decided_by": "Who had final say",
      "stakeholders": ["person1", "person2"],
      "context_quote": "Brief transcript excerpt"
    }
  ]
}

## Rules
- P0 = blocking/urgent, P1 = this week, P2 = this sprint, P3 = backlog
- For owner names, use the full name if available from the participant list
- Only extract genuine action items (commitments to do something), not observations
- Only extract genuine decisions (choices made), not discussions without resolution
- If no action items or decisions, return empty arrays
- Keep context_quote to 1-2 sentences max
- topics: Extract 3-8 key themes discussed`

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Process a single meeting: assemble transcript, call LLM, store artifacts,
 * feed into knowledge graph and memory.
 */
export async function processMeeting(meetingId: string): Promise<ProcessingResult> {
  const startTime = Date.now()
  const supabase = createAdminClient() as any // meeting tables not in generated types yet

  try {
    // 1. Fetch meeting details
    const { data: meeting, error: meetingErr } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meetingId)
      .single()

    if (meetingErr || !meeting) {
      return {
        meetingId,
        status: 'failed',
        actionItemsCount: 0,
        decisionsCount: 0,
        durationMs: Date.now() - startTime,
        error: `Meeting not found: ${meetingErr?.message}`,
      }
    }

    // 2. Fetch bot config for model selection
    const { data: botConfig } = await supabase
      .from('meeting_bot_config')
      .select('summarization_model')
      .eq('org_id', meeting.org_id)
      .maybeSingle()

    let model = botConfig?.summarization_model || DEFAULT_SUMMARIZATION_MODEL
    // Ensure model has provider prefix for OpenRouter (e.g. "anthropic/claude-...")
    if (model && !model.includes('/')) {
      model = `anthropic/${model}`
    }

    // 3. Assemble full transcript
    const { data: segments, error: segErr } = await supabase
      .from('transcript_segments')
      .select('speaker, text, start_time, end_time, confidence')
      .eq('meeting_id', meetingId)
      .eq('is_final', true)
      .order('start_time', { ascending: true })

    if (segErr || !segments || segments.length === 0) {
      await markFailed(supabase, meetingId, 'No transcript segments found')
      return {
        meetingId,
        status: 'failed',
        actionItemsCount: 0,
        decisionsCount: 0,
        durationMs: Date.now() - startTime,
        error: 'No transcript segments',
      }
    }

    const fullTranscript = assembleTranscript(segments)
    const durationMinutes = segments.length > 0
      ? Math.round(((segments[segments.length - 1].end_time ?? 0) - (segments[0].start_time ?? 0)) / 60)
      : 0

    // 4. Build LLM prompt
    const participants = (meeting.participants as Array<{ name: string; email: string }>) || []
    const participantList = participants.map(p => `${p.name} (${p.email})`).join(', ')

    const userPrompt = buildUserPrompt({
      title: meeting.title,
      date: meeting.scheduled_start,
      duration: durationMinutes,
      participants: participantList,
      transcript: fullTranscript,
    })

    // 5. Call LLM with retries
    let summaryResult: MeetingSummaryResult | null = null
    let tokensUsed: { prompt_tokens: number; completion_tokens: number } | null = null
    let lastError = ''

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await callSummarizationLLM(model, userPrompt)
        summaryResult = result.parsed
        tokensUsed = result.usage
        break
      } catch (err) {
        lastError = (err as Error).message
        console.error(`[meeting-processor] LLM attempt ${attempt + 1}/${MAX_RETRIES} failed:`, lastError)
        // Exponential backoff: 5s, 15s, 45s
        if (attempt < MAX_RETRIES - 1) {
          await sleep(5000 * Math.pow(3, attempt))
        }
      }
    }

    if (!summaryResult) {
      await markFailed(supabase, meetingId, `LLM failed after ${MAX_RETRIES} retries: ${lastError}`)
      return {
        meetingId,
        status: 'failed',
        actionItemsCount: 0,
        decisionsCount: 0,
        durationMs: Date.now() - startTime,
        error: lastError,
      }
    }

    // 6. Store summary
    const costUsd = tokensUsed
      ? estimateCost(model, tokensUsed.prompt_tokens, tokensUsed.completion_tokens)
      : 0

    await supabase.from('meeting_summaries').upsert(
      {
        meeting_id: meetingId,
        org_id: meeting.org_id,
        tldr: summaryResult.tldr,
        executive_summary: summaryResult.executive_summary,
        detailed_summary: summaryResult.detailed_summary,
        topics: summaryResult.topics as unknown as Json,
        model_used: model,
        tokens_used: tokensUsed as unknown as Json,
        cost_usd: costUsd,
        processing_time_ms: Date.now() - startTime,
      },
      { onConflict: 'meeting_id' }
    )

    // 7. Store action items
    if (summaryResult.action_items.length > 0) {
      const actionRows = summaryResult.action_items.map(item => ({
        meeting_id: meetingId,
        org_id: meeting.org_id,
        action: item.action,
        owner_name: item.owner || null,
        owner_email: matchParticipantEmail(item.owner, participants),
        due_date: item.due_date || null,
        priority: item.priority || 'P2',
        context_quote: item.context_quote || null,
        context_timestamp: findTimestampForQuote(item.context_quote, segments),
        status: 'open' as const,
      }))

      await supabase.from('meeting_action_items').insert(actionRows)
    }

    // 8. Store decisions
    if (summaryResult.decisions.length > 0) {
      const decisionRows = summaryResult.decisions.map(d => ({
        meeting_id: meetingId,
        org_id: meeting.org_id,
        decision: d.decision,
        rationale: d.rationale || null,
        decided_by: d.decided_by || null,
        stakeholders: (d.stakeholders || []) as unknown as Json,
        context_quote: d.context_quote || null,
        context_timestamp: findTimestampForQuote(d.context_quote, segments),
      }))

      await supabase.from('meeting_decisions').insert(decisionRows)
    }

    // 9. Mark meeting as completed
    await supabase
      .from('meetings')
      .update({
        status: 'completed',
        summary_ready: true,
        error_message: null,
      })
      .eq('id', meetingId)

    // 10. Feed into knowledge graph (fire-and-forget, like morning brief)
    const graphContent = buildGraphExtractionContent(meeting.title, summaryResult, fullTranscript)
    runExtractionPipeline({
      orgId: meeting.org_id,
      conversationId: randomUUID(),
      messageContent: graphContent,
      role: 'assistant',
    }).catch(err => {
      console.error(`[meeting-processor] Extraction pipeline failed for ${meetingId}:`, err)
    })

    // 11. Store meeting outcome as memory (fire-and-forget)
    storeMeetingMemory(supabase, meeting, summaryResult).catch(err => {
      console.error(`[meeting-processor] Memory storage failed for ${meetingId}:`, err)
    })

    const result: ProcessingResult = {
      meetingId,
      status: 'completed',
      summary: { tldr: summaryResult.tldr },
      actionItemsCount: summaryResult.action_items.length,
      decisionsCount: summaryResult.decisions.length,
      durationMs: Date.now() - startTime,
    }

    console.log(
      `[meeting-processor] Completed ${meetingId}: ` +
      `${summaryResult.action_items.length} actions, ${summaryResult.decisions.length} decisions ` +
      `(${Date.now() - startTime}ms, $${costUsd.toFixed(4)})`
    )

    return result
  } catch (error) {
    const errMsg = (error as Error).message
    console.error(`[meeting-processor] Fatal error for ${meetingId}:`, errMsg)
    await markFailed(createAdminClient(), meetingId, errMsg)

    return {
      meetingId,
      status: 'failed',
      actionItemsCount: 0,
      decisionsCount: 0,
      durationMs: Date.now() - startTime,
      error: errMsg,
    }
  }
}

// ─── Transcript Assembly ─────────────────────────────────────────────────

interface TranscriptSegment {
  speaker: string | null
  text: string
  start_time: number | null
  end_time: number | null
  confidence: number | null
}

function assembleTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = []
  let currentSpeaker = ''

  for (const seg of segments) {
    const speaker = seg.speaker || 'Unknown'
    const timestamp = seg.start_time != null
      ? `[${formatTimestamp(seg.start_time)}]`
      : ''

    if (speaker !== currentSpeaker) {
      lines.push(`\n${speaker} ${timestamp}:`)
      currentSpeaker = speaker
    }

    lines.push(seg.text)
  }

  return lines.join('\n').trim()
}

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ─── LLM Call ────────────────────────────────────────────────────────────

interface LLMResult {
  parsed: MeetingSummaryResult
  usage: { prompt_tokens: number; completion_tokens: number }
}

async function callSummarizationLLM(model: string, userPrompt: string): Promise<LLMResult> {
  if (!LLM_API_KEY) {
    throw new Error('NVIDIA_API_KEY or OPENROUTER_API_KEY not configured')
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Captain Meeting Summarizer',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: MEETING_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 4000,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM call failed (${response.status}): ${err}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content

  if (!content) {
    throw new Error('Empty LLM response')
  }

  let parsed: MeetingSummaryResult
  try {
    parsed = JSON.parse(content)
  } catch {
    // Lenient parse: try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1])
    } else {
      throw new Error(`Malformed JSON from LLM: ${content.slice(0, 200)}`)
    }
  }

  // Validate and default missing fields
  parsed.tldr = parsed.tldr || ''
  parsed.executive_summary = parsed.executive_summary || ''
  parsed.detailed_summary = parsed.detailed_summary || ''
  parsed.topics = parsed.topics || []
  parsed.action_items = parsed.action_items || []
  parsed.decisions = parsed.decisions || []

  return {
    parsed,
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
  }
}

// ─── User Prompt Builder ─────────────────────────────────────────────────

function buildUserPrompt(opts: {
  title: string
  date: string | null
  duration: number
  participants: string
  transcript: string
}): string {
  // Cap transcript to ~50K chars (~12K tokens) to stay within budget
  const cappedTranscript = opts.transcript.slice(0, 50000)
  const truncated = opts.transcript.length > 50000
    ? '\n\n[... transcript truncated for length ...]'
    : ''

  return `## Meeting Details
- **Title:** ${opts.title}
- **Date:** ${opts.date || 'Unknown'}
- **Duration:** ~${opts.duration} minutes
- **Participants:** ${opts.participants || 'Unknown'}

## Full Transcript

${cappedTranscript}${truncated}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function matchParticipantEmail(
  ownerName: string | null,
  participants: Array<{ name: string; email: string }>
): string | null {
  if (!ownerName || participants.length === 0) return null

  const normalized = ownerName.toLowerCase().trim()

  // Exact match
  const exact = participants.find(p => p.name.toLowerCase().trim() === normalized)
  if (exact) return exact.email

  // Partial match (first name or last name)
  const partial = participants.find(p => {
    const parts = p.name.toLowerCase().split(' ')
    return parts.some(part => normalized.includes(part) || part.includes(normalized))
  })

  return partial?.email ?? null
}

function findTimestampForQuote(
  quote: string | null,
  segments: TranscriptSegment[]
): number | null {
  if (!quote || segments.length === 0) return null

  // Simple substring search in transcript text
  const normalizedQuote = quote.toLowerCase().slice(0, 80)
  for (const seg of segments) {
    if (seg.text.toLowerCase().includes(normalizedQuote.slice(0, 30))) {
      return seg.start_time
    }
  }

  return null
}

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  // Rough pricing per million tokens via OpenRouter
  const pricing: Record<string, { input: number; output: number }> = {
    'anthropic/claude-haiku-4.5': { input: 0.80, output: 4.00 },
    'anthropic/claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
    'minimax/minimax-m2.5': { input: 0.50, output: 1.50 },
    'x-ai/grok-4.1-fast': { input: 0.30, output: 0.50 },
  }

  const rate = pricing[model] || { input: 1.0, output: 3.0 }
  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000
}

function buildGraphExtractionContent(
  title: string,
  summary: MeetingSummaryResult,
  transcript: string
): string {
  // Build a focused text for entity extraction — not the whole transcript
  const lines = [
    `Meeting: ${title}`,
    `Summary: ${summary.tldr}`,
    '',
    summary.executive_summary,
    '',
  ]

  for (const item of summary.action_items) {
    lines.push(`Action item: ${item.action} (owner: ${item.owner}, due: ${item.due_date || 'unset'})`)
  }

  for (const d of summary.decisions) {
    lines.push(`Decision: ${d.decision} (by: ${d.decided_by})`)
  }

  // Include a sample of transcript for richer entity extraction (capped)
  lines.push('\n## Transcript Excerpt')
  lines.push(transcript.slice(0, 8000))

  return lines.join('\n')
}

async function storeMeetingMemory(
  supabase: ReturnType<typeof createAdminClient>,
  meeting: Record<string, unknown>,
  summary: MeetingSummaryResult
): Promise<void> {
  const orgId = meeting.org_id as string
  const title = meeting.title as string
  const scheduledStart = meeting.scheduled_start as string | null

  // Extract related entity names from action items + decisions
  const relatedEntities = new Set<string>()
  for (const item of summary.action_items) {
    if (item.owner) relatedEntities.add(item.owner)
  }
  for (const d of summary.decisions) {
    if (d.decided_by) relatedEntities.add(d.decided_by)
    for (const s of d.stakeholders || []) relatedEntities.add(s)
  }

  // Store as meeting_outcome memory (same category as existing system)
  await supabase.from('memory').insert({
    org_id: orgId,
    category: 'meeting_outcome',
    subject: `Meeting: ${title}`,
    content: [
      summary.tldr,
      '',
      '**Action Items:**',
      ...summary.action_items.map(a => `- ${a.action} (${a.owner}, ${a.priority})`),
      '',
      '**Decisions:**',
      ...summary.decisions.map(d => `- ${d.decision} — ${d.rationale || 'no rationale noted'}`),
    ].join('\n'),
    related_entities: Array.from(relatedEntities),
    confidence: 0.9,
    source: 'meeting_bot',
    event_date: scheduledStart ? scheduledStart.slice(0, 10) : null,
  })
}

async function markFailed(
  supabase: any, // meeting tables not in generated types yet
  meetingId: string,
  error: string
): Promise<void> {
  await supabase
    .from('meetings')
    .update({
      status: 'failed',
      error_message: error.slice(0, 500),
    })
    .eq('id', meetingId)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Batch Processor (for cron) ──────────────────────────────────────────

/**
 * Process all meetings that are in 'processing' status.
 * Called from the cron job. Returns summary of results.
 */
export async function processAllPendingMeetings(): Promise<{
  processed: number
  succeeded: number
  failed: number
  results: ProcessingResult[]
}> {
  const supabase = createAdminClient() as any // meeting tables not in generated types yet

  const { data: pendingMeetings } = await supabase
    .from('meetings')
    .select('id')
    .in('status', ['processing', 'transcribing'])
    .lt('retry_count', MAX_RETRIES)
    .order('scheduled_start', { ascending: true })
    .limit(10) // Process max 10 per cron run

  if (!pendingMeetings || pendingMeetings.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, results: [] }
  }

  const results: ProcessingResult[] = []

  for (const meeting of pendingMeetings) {
    // Update status to processing if not already
    await supabase
      .from('meetings')
      .update({ status: 'processing' })
      .eq('id', meeting.id)

    const result = await processMeeting(meeting.id)
    results.push(result)
  }

  return {
    processed: results.length,
    succeeded: results.filter(r => r.status === 'completed').length,
    failed: results.filter(r => r.status === 'failed').length,
    results,
  }
}
