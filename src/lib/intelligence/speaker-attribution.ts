// ─── LLM-Powered Speaker Attribution ──────────────────────────────────────────
// When DOM-based speaker tracking fails during recording, all transcript segments
// end up with the same speaker (either concatenated participant names or "Unknown").
//
// This module uses an LLM to attribute speakers to transcript segments based on
// conversational context: greeting patterns, name mentions, topic expertise,
// question-response flow, and pronoun usage.
//
// Called from meeting-processor.ts BEFORE summarization, so the attributed
// transcript feeds into the summary for consistent speaker identification.
//
// Pattern: Same as meeting-processor — retries, error handling, never throws.

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Types ───────────────────────────────────────────────────────────────

interface TranscriptSegment {
  id: string
  speaker: string | null
  text: string
  start_time: number | null
  end_time: number | null
}

interface SpeakerAttribution {
  index: number
  speaker: string
  confidence: number
}

export interface AttributionResult {
  attributed: number
  skipped: number
  speakers: string[]
  durationMs: number
}

// ─── Config ──────────────────────────────────────────────────────────────
// Speaker attribution uses the same NVIDIA/Kimi stack as the evidence pipeline.
// Override with SPEAKER_ATTRIBUTION_* env vars if needed.

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''

const ATTRIBUTION_API_KEY = process.env.SPEAKER_ATTRIBUTION_API_KEY
  || NVIDIA_API_KEY
  || OPENROUTER_API_KEY
const ATTRIBUTION_BASE_URL = process.env.SPEAKER_ATTRIBUTION_BASE_URL
  || (ATTRIBUTION_API_KEY === NVIDIA_API_KEY && NVIDIA_API_KEY
    ? 'https://integrate.api.nvidia.com/v1'
    : 'https://openrouter.ai/api/v1')
const ATTRIBUTION_MODEL = process.env.SPEAKER_ATTRIBUTION_MODEL
  || (ATTRIBUTION_API_KEY === NVIDIA_API_KEY && NVIDIA_API_KEY
    ? 'moonshotai/kimi-k2.5'
    : 'anthropic/claude-haiku-4.5')
const ATTRIBUTION_MAX_TOKENS = Math.max(
  Number(process.env.SPEAKER_ATTRIBUTION_MAX_TOKENS) || 32768, 4000
)
// Per-chunk fetch timeout (ms) — prevents hanging on unresponsive APIs
const ATTRIBUTION_FETCH_TIMEOUT_MS = Number(process.env.SPEAKER_ATTRIBUTION_TIMEOUT_MS) || 90_000

// Max segments per LLM call (to stay within context limits)
const CHUNK_SIZE = 80
// Overlap between chunks to maintain context across boundaries
const CHUNK_OVERLAP =5

// ─── System Prompt ───────────────────────────────────────────────────────

const ATTRIBUTION_SYSTEM_PROMPT = `You are a meeting transcript analyst. Your job is to identify which participant is speaking in each segment of a meeting transcript.

The transcript was recorded without speaker identification. Analyze conversational patterns to determine who is speaking:

## Clues to use:
1. **Self-identification**: "This is Max" / "Hey, I'm Anna" / "Max here"
2. **Name mentions**: "What do you think, Prashanth?" → next segment is likely Prashanth
3. **Greetings**: First few segments often have each person saying hello
4. **Topic expertise**: If someone is explaining their product, they're likely from that team
5. **Response patterns**: Questions followed by answers indicate speaker changes
6. **Pronouns**: "We at Crane" vs "We at KeyValue" indicates team affiliation
7. **Continuity**: Same speaker often continues across short consecutive segments
8. **Turn-taking cues**: "Go ahead" / "Yeah so..." / "Sure, let me explain" indicate speaker change
9. **Silence gaps**: Segments with time gaps between them often indicate speaker changes

## Rules:
- Use ONLY names from the provided participant list
- If you're uncertain about a segment, use your best guess based on context
- Only use "Unknown" if there is genuinely no way to determine the speaker
- Consecutive segments of similar topic/style are likely the same speaker
- Short segments like "Yeah", "Okay", "Right" following a question are often the person being asked

Respond with a JSON array: [{"index": 0, "speaker": "Name", "confidence": 0.8}, ...]
where confidence is 0.0-1.0 indicating how sure you are.`

// ─── Main Entry ──────────────────────────────────────────────────────────

/**
 * Check if a meeting's transcript needs speaker attribution and run it.
 * Returns null if no attribution needed (speakers already differentiated).
 */
export async function attributeSpeakersIfNeeded(
  meetingId: string
): Promise<AttributionResult | null> {
  const startTime = Date.now()
  const supabase = createAdminClient() as any

  try {
    // 1. Fetch meeting details for participant list
    const { data: meeting } = await supabase
      .from('meetings')
      .select('title, participants')
      .eq('id', meetingId)
      .single()

    if (!meeting) {
      console.error(`[speaker-attribution] Meeting ${meetingId} not found`)
      return null
    }

    // 2. Fetch transcript segments
    const { data: segments, error: segErr } = await supabase
      .from('transcript_segments')
      .select('id, speaker, text, start_time, end_time')
      .eq('meeting_id', meetingId)
      .eq('is_final', true)
      .order('start_time', { ascending: true })

    if (segErr || !segments || segments.length === 0) {
      return null
    }

    // 3. Check if attribution is needed
    const uniqueSpeakers = new Set(
      (segments as TranscriptSegment[]).map(s => s.speaker || 'Unknown')
    )

    // If there are already multiple distinct speakers, skip attribution
    // Exception: if the "speaker" is a comma-separated list of names (bug), still fix it
    const hasConcatenatedSpeaker = [...uniqueSpeakers].some(s =>
      s.includes(',') && s.split(',').length >= 3
    )

    if (uniqueSpeakers.size > 2 && !hasConcatenatedSpeaker) {
      console.log(`[speaker-attribution] ${meetingId}: ${uniqueSpeakers.size} speakers already identified — skipping`)
      return null
    }

    // If just 1 speaker but it's "System" (no speech detected marker), skip
    if (uniqueSpeakers.size === 1 && uniqueSpeakers.has('System')) {
      return null
    }

    console.log(
      `[speaker-attribution] ${meetingId}: needs attribution ` +
      `(${uniqueSpeakers.size} unique speaker(s): ${[...uniqueSpeakers].map(s => s.slice(0, 30)).join(', ')})`
    )

    // 4. Get participant names
    const participants = (meeting.participants as Array<{ name: string; email: string }>) || []
    const participantNames = participants.map(p => p.name).filter(Boolean)

    if (participantNames.length === 0) {
      console.warn(`[speaker-attribution] ${meetingId}: no participant names available — can't attribute`)
      // Still clean up the concatenated speaker name to "Unknown"
      if (hasConcatenatedSpeaker) {
        await supabase
          .from('transcript_segments')
          .update({ speaker: 'Unknown', speaker_id: 0 })
          .eq('meeting_id', meetingId)
          .eq('is_final', true)
        // Also fix speaker map
        await supabase
          .from('meeting_speaker_map')
          .delete()
          .eq('meeting_id', meetingId)
      }
      return { attributed: 0, skipped: segments.length, speakers: [], durationMs: Date.now() - startTime }
    }

    // 5. Run LLM attribution in chunks
    const allAttributions = await runChunkedAttribution(
      segments as TranscriptSegment[],
      participantNames,
      meeting.title || 'Meeting'
    )

    if (allAttributions.length === 0) {
      console.warn(`[speaker-attribution] ${meetingId}: LLM returned no attributions`)
      return { attributed: 0, skipped: segments.length, speakers: [], durationMs: Date.now() - startTime }
    }

    // 6. Build speaker map and update DB
    const speakerSet = new Set<string>()
    const speakerIdMap = new Map<string, number>()
    let nextSpeakerId = 0

    // Batch update segments
    let attributed = 0
    for (const attr of allAttributions) {
      const seg = (segments as TranscriptSegment[])[attr.index]
      if (!seg) continue

      const speaker = attr.speaker
      if (!speakerIdMap.has(speaker)) {
        speakerIdMap.set(speaker, nextSpeakerId++)
      }
      speakerSet.add(speaker)

      const { error: updateErr } = await supabase
        .from('transcript_segments')
        .update({
          speaker: speaker,
          speaker_id: speakerIdMap.get(speaker),
        })
        .eq('id', seg.id)

      if (!updateErr) attributed++
    }

    // 7. Update speaker map table
    await supabase
      .from('meeting_speaker_map')
      .delete()
      .eq('meeting_id', meetingId)

    const speakerMapRows = [...speakerIdMap.entries()].map(([name, id]) => ({
      meeting_id: meetingId,
      speaker_id: id,
      speaker_label: name,
      confidence: 0.75, // LLM attribution confidence
    }))

    if (speakerMapRows.length > 0) {
      await supabase
        .from('meeting_speaker_map')
        .insert(speakerMapRows)
    }

    const speakers = [...speakerSet]
    console.log(
      `[speaker-attribution] ${meetingId}: attributed ${attributed}/${segments.length} segments to ${speakers.length} speakers: ${speakers.join(', ')} (${Date.now() - startTime}ms)`
    )

    return {
      attributed,
      skipped: segments.length - attributed,
      speakers,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    console.error(`[speaker-attribution] Fatal error for ${meetingId}:`, (err as Error).message)
    return {
      attributed: 0,
      skipped: 0,
      speakers: [],
      durationMs: Date.now() - startTime,
    }
  }
}

// ─── Chunked LLM Attribution ─────────────────────────────────────────────

async function runChunkedAttribution(
  segments: TranscriptSegment[],
  participants: string[],
  meetingTitle: string
): Promise<SpeakerAttribution[]> {
  // Build chunk descriptors
  const chunks: { start: number; end: number; isFirst: boolean }[] = []
  for (let start = 0; start < segments.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_SIZE, segments.length)
    chunks.push({ start, end, isFirst: start === 0 })
  }

  console.log(`[speaker-attribution] Processing ${chunks.length} chunks in parallel`)

  // Fire all chunks in parallel — Kimi reasoning takes ~60s per chunk,
  // so sequential processing would exceed Vercel's 300s maxDuration.
  const results = await Promise.allSettled(
    chunks.map(({ start, end, isFirst }) =>
      callAttributionLLM(
        segments.slice(start, end),
        start,
        participants,
        meetingTitle,
        isFirst
      ).then(attrs => ({ start, end, attrs }))
    )
  )

  // Merge results — for overlap regions, prefer later chunks (more context)
  const allAttributions: SpeakerAttribution[] = []
  let succeeded = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      const errMsg = result.reason?.message || String(result.reason)
      console.error(`[speaker-attribution] Chunk failed: ${errMsg}`)
      continue
    }
    succeeded++
    const { start, end, attrs } = result.value
    console.log(`[speaker-attribution] Chunk ${start}-${end}: ${attrs.length} attributions`)
    const isFirstChunk = start === 0
    for (const attr of attrs) {
      const existing = allAttributions.find(a => a.index === attr.index)
      if (!existing) {
        allAttributions.push(attr)
      } else if (!isFirstChunk && attr.confidence > existing.confidence) {
        existing.speaker = attr.speaker
        existing.confidence = attr.confidence
      }
    }
  }

  console.log(`[speaker-attribution] ${succeeded}/${results.length} chunks succeeded, ${allAttributions.length} total attributions`)
  return allAttributions
}

// ─── LLM Call ────────────────────────────────────────────────────────────

async function callAttributionLLM(
  chunk: TranscriptSegment[],
  globalOffset: number,
  participants: string[],
  meetingTitle: string,
  isFirstChunk: boolean,
): Promise<SpeakerAttribution[]> {
  if (!ATTRIBUTION_API_KEY) {
    throw new Error('No LLM API key configured for speaker attribution')
  }

  // Build compact transcript for the chunk
  const segmentLines = chunk.map((seg, localIdx) => {
    const globalIdx = globalOffset + localIdx
    const time = seg.start_time != null
      ? `[${Math.floor(seg.start_time / 60)}:${String(Math.floor(seg.start_time % 60)).padStart(2, '0')}]`
      : ''
    return `${globalIdx}. ${time} "${seg.text}"`
  }).join('\n')

  const userPrompt = `## Meeting: ${meetingTitle}
## Participants: ${participants.join(', ')}
${isFirstChunk ? '## Note: This is the START of the meeting. Early segments often contain greetings where participants identify themselves.' : '## Note: This is a CONTINUATION. Maintain speaker consistency with the conversation flow.'}

## Transcript Segments (identify the speaker for each):
${segmentLines}

Respond with JSON array only. Each object: {"index": <segment_number>, "speaker": "<participant_name>", "confidence": <0.0-1.0>}`

  console.log(
    `[speaker-attribution] Calling ${ATTRIBUTION_MODEL} via ${ATTRIBUTION_BASE_URL} ` +
    `for ${chunk.length} segments (offset ${globalOffset}, max_tokens=${ATTRIBUTION_MAX_TOKENS})`
  )

  // AbortController for fetch timeout
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ATTRIBUTION_FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${ATTRIBUTION_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ATTRIBUTION_API_KEY}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Captain Speaker Attribution',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ATTRIBUTION_MODEL,
        messages: [
          { role: 'system', content: ATTRIBUTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: ATTRIBUTION_MAX_TOKENS,
      }),
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Attribution LLM failed (${response.status}): ${err.slice(0, 200)}`)
  }

  const data = await response.json()
  const usage = data.usage
  console.log(
    `[speaker-attribution] LLM response: finish_reason=${data.choices?.[0]?.finish_reason}` +
    `, tokens=${usage?.prompt_tokens || '?'}→${usage?.completion_tokens || '?'}`
  )

  const message = data.choices?.[0]?.message
  // Reasoning models (e.g. kimi-k2.5) put chain-of-thought in reasoning_content
  // and the actual answer in content. Handle both.
  const content = message?.content

  if (!content) {
    const hasReasoning = !!(message?.reasoning_content || message?.reasoning)
    const finishReason = data.choices?.[0]?.finish_reason
    throw new Error(
      `Empty LLM response for attribution` +
      (hasReasoning && finishReason === 'length'
        ? ` — reasoning model exhausted max_tokens (${ATTRIBUTION_MAX_TOKENS}) on thinking. Increase SPEAKER_ATTRIBUTION_MAX_TOKENS.`
        : ` (finish_reason=${finishReason}, has_reasoning=${hasReasoning})`)
    )
  }

  // Parse response — handle both raw array and {attributions: [...]} wrapper
  let parsed: SpeakerAttribution[]
  try {
    const raw = JSON.parse(content)
    if (Array.isArray(raw)) {
      parsed = raw
    } else if (raw.attributions && Array.isArray(raw.attributions)) {
      parsed = raw.attributions
    } else if (raw.segments && Array.isArray(raw.segments)) {
      parsed = raw.segments
    } else if (raw.results && Array.isArray(raw.results)) {
      parsed = raw.results
    } else {
      // Try to find first array value in the object
      const firstArray = Object.values(raw).find(v => Array.isArray(v)) as SpeakerAttribution[] | undefined
      if (firstArray) {
        parsed = firstArray
      } else {
        throw new Error('No array found in response')
      }
    }
  } catch (parseErr) {
    // Try to extract JSON array from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      const inner = JSON.parse(jsonMatch[1])
      parsed = Array.isArray(inner) ? inner : (inner.attributions || inner.segments || inner.results || [])
    } else {
      // Last resort: try to find a JSON array in the content
      const arrayMatch = content.match(/\[[\s\S]*\]/)
      if (arrayMatch) {
        parsed = JSON.parse(arrayMatch[0])
      } else {
        throw new Error(`Couldn't parse attribution response: ${content.slice(0, 200)}`)
      }
    }
  }

  // Validate and clean: only keep attributions with valid participant names
  const validNames = new Set(participants.map(n => n.toLowerCase()))
  const validAttributions: SpeakerAttribution[] = []

  for (const attr of parsed) {
    if (typeof attr.index !== 'number' || !attr.speaker) continue

    // Check if speaker is a valid participant (case-insensitive fuzzy match)
    const speakerLower = attr.speaker.toLowerCase().trim()
    let matchedName = participants.find(p => p.toLowerCase() === speakerLower)

    // Fuzzy match: first name only
    if (!matchedName) {
      matchedName = participants.find(p => {
        const firstName = p.split(' ')[0].toLowerCase()
        return firstName === speakerLower || speakerLower.includes(firstName)
      })
    }

    // If still no match but it's "Unknown", keep it
    if (!matchedName && speakerLower !== 'unknown') {
      // Check partial match on any name part
      matchedName = participants.find(p =>
        p.toLowerCase().split(/\s+/).some(part => part.length > 2 && speakerLower.includes(part))
      )
    }

    validAttributions.push({
      index: attr.index,
      speaker: matchedName || attr.speaker, // Use exact participant name casing
      confidence: typeof attr.confidence === 'number' ? attr.confidence : 0.6,
    })
  }

  return validAttributions
}
