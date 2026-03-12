import type { MeetingStatus } from '@/types/meetings'

const DEFAULT_EXPECTED_DURATION_SECONDS = 60 * 60
const MAX_MEETING_DURATION_SECONDS = 6 * 60 * 60
const MISSED_JOIN_GRACE_SECONDS = 15 * 60
const JOINING_STALE_SECONDS = 20 * 60
const TRANSCRIBING_STALE_SECONDS = 2 * 60 * 60
const PROCESSING_STALE_SECONDS = 2 * 60 * 60
const MAX_SEGMENT_DURATION_SECONDS = 10 * 60
const MAX_SEGMENT_CHARACTERS = 8_000
const MIN_USABLE_SEGMENTS = 3
const MIN_USABLE_WORDS = 20

const GUARDRAIL_PREFIX = '[meeting-guardrail]'

export interface MeetingGuardrailInput {
  id?: string
  title?: string | null
  status: MeetingStatus
  scheduled_start?: string | null
  scheduled_end?: string | null
  actual_start?: string | null
  actual_end?: string | null
  updated_at?: string | null
  duration_seconds?: number | null
  transcript_ready?: boolean | null
  summary_ready?: boolean | null
}

export interface MeetingTranscriptSegmentLike {
  speaker: string | null
  text: string
  start_time: number | null
  end_time: number | null
  confidence: number | null
}

export interface SanitizedTranscriptResult<TSegment> {
  usableSegments: TSegment[]
  droppedSegments: TSegment[]
  droppedReasons: string[]
  totalWordCount: number
  usable: boolean
}

export interface StaleMeetingDecision {
  reason: string
  status: 'failed'
  skipReason?: string
  setActualEnd: boolean
}

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

function countWords(text: string): number {
  const words = text.trim().match(/\S+/g)
  return words?.length ?? 0
}

function buildGuardrailReason(code: string, message: string): string {
  return `${GUARDRAIL_PREFIX}[${code}] ${message}`
}

export function isGuardrailFailure(message: string | null | undefined): boolean {
  return Boolean(message && message.startsWith(GUARDRAIL_PREFIX))
}

export function computeMeetingDurationCapSeconds(meeting: Pick<MeetingGuardrailInput, 'scheduled_start' | 'scheduled_end'>): number {
  const scheduledStartMs = parseIso(meeting.scheduled_start)
  const scheduledEndMs = parseIso(meeting.scheduled_end)

  const expectedDurationSeconds = scheduledStartMs && scheduledEndMs && scheduledEndMs > scheduledStartMs
    ? Math.round((scheduledEndMs - scheduledStartMs) / 1000)
    : DEFAULT_EXPECTED_DURATION_SECONDS

  const graceSeconds = Math.max(
    30 * 60,
    Math.min(90 * 60, Math.round(expectedDurationSeconds * 0.5))
  )
  const scaledCap = Math.max(expectedDurationSeconds * 3, expectedDurationSeconds + graceSeconds)

  return Math.min(MAX_MEETING_DURATION_SECONDS, scaledCap)
}

export function getAbsurdRecordingReason(
  meeting: Pick<MeetingGuardrailInput, 'scheduled_start' | 'scheduled_end' | 'actual_start'>,
  reportedDurationSeconds: number | null | undefined,
  now = new Date()
): string | null {
  const capSeconds = computeMeetingDurationCapSeconds(meeting)
  const actualStartMs = parseIso(meeting.actual_start)
  const elapsedSinceStartSeconds = actualStartMs
    ? Math.round((now.getTime() - actualStartMs) / 1000)
    : null

  if (typeof reportedDurationSeconds === 'number' && reportedDurationSeconds > capSeconds) {
    return buildGuardrailReason(
      'absurd_duration',
      `Recording reported ${Math.round(reportedDurationSeconds / 60)}m which exceeds cap of ${Math.round(capSeconds / 60)}m`
    )
  }

  if (elapsedSinceStartSeconds && elapsedSinceStartSeconds > capSeconds) {
    return buildGuardrailReason(
      'stale_recording',
      `Recording elapsed ${Math.round(elapsedSinceStartSeconds / 60)}m which exceeds cap of ${Math.round(capSeconds / 60)}m`
    )
  }

  return null
}

export function getStaleMeetingDecision(
  meeting: MeetingGuardrailInput,
  now = new Date()
): StaleMeetingDecision | null {
  const nowMs = now.getTime()
  const scheduledStartMs = parseIso(meeting.scheduled_start)
  const actualStartMs = parseIso(meeting.actual_start)
  const actualEndMs = parseIso(meeting.actual_end)
  const updatedAtMs = parseIso(meeting.updated_at)
  const referenceMs = updatedAtMs ?? scheduledStartMs ?? actualStartMs ?? actualEndMs

  if (meeting.summary_ready) {
    return null
  }

  switch (meeting.status) {
    case 'scheduled': {
      if (!scheduledStartMs) return null
      if (nowMs - scheduledStartMs < MISSED_JOIN_GRACE_SECONDS * 1000) return null

      return {
        status: 'failed',
        reason: buildGuardrailReason('missed_join', 'Meeting was not joined within the allowed grace period'),
        skipReason: 'Meeting was not joined in time',
        setActualEnd: false,
      }
    }

    case 'joining': {
      if (!referenceMs || nowMs - referenceMs < JOINING_STALE_SECONDS * 1000) return null

      return {
        status: 'failed',
        reason: buildGuardrailReason('stale_joining', 'Bot remained in joining state too long'),
        skipReason: 'Bot got stuck while joining the meeting',
        setActualEnd: false,
      }
    }

    case 'recording': {
      const staleReason = getAbsurdRecordingReason(meeting, meeting.duration_seconds, now)
      if (!staleReason) return null

      return {
        status: 'failed',
        reason: staleReason,
        skipReason: 'Recording session exceeded the allowed duration',
        setActualEnd: true,
      }
    }

    case 'transcribing': {
      if (!referenceMs || nowMs - referenceMs < TRANSCRIBING_STALE_SECONDS * 1000) return null

      return {
        status: 'failed',
        reason: buildGuardrailReason('stale_transcribing', 'Transcription did not complete within the allowed window'),
        skipReason: 'Transcription timed out',
        setActualEnd: false,
      }
    }

    case 'processing': {
      if (!referenceMs || nowMs - referenceMs < PROCESSING_STALE_SECONDS * 1000) return null

      return {
        status: 'failed',
        reason: buildGuardrailReason('stale_processing', 'Summarization did not complete within the allowed window'),
        skipReason: 'Meeting processing timed out',
        setActualEnd: false,
      }
    }

    default:
      return null
  }
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function looksHighlyRepetitive(text: string): boolean {
  const normalizedWords = normalizeWords(text)
  if (normalizedWords.length < 40) return false

  const uniqueWordRatio = new Set(normalizedWords).size / normalizedWords.length
  if (text.length > 1000 && uniqueWordRatio < 0.35) {
    return true
  }

  const phraseCounts = new Map<string, number>()
  for (let index = 0; index <= normalizedWords.length - 6; index++) {
    const phrase = normalizedWords.slice(index, index + 6).join(' ')
    phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1)
  }

  return Array.from(phraseCounts.values()).some(count => count >= 3)
}

export function sanitizeTranscriptSegments<TSegment extends MeetingTranscriptSegmentLike>(
  segments: TSegment[]
): SanitizedTranscriptResult<TSegment> {
  const usableSegments: TSegment[] = []
  const droppedSegments: TSegment[] = []
  const droppedReasons: string[] = []
  let totalWordCount = 0

  for (const segment of segments) {
    const text = segment.text?.trim() ?? ''
    const start = typeof segment.start_time === 'number' ? segment.start_time : null
    const end = typeof segment.end_time === 'number' ? segment.end_time : null
    const durationSeconds = start != null && end != null ? end - start : null
    let dropReason: string | null = null

    if (!text) {
      dropReason = 'empty_text'
    } else if (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
      dropReason = 'invalid_duration'
    } else if (durationSeconds != null && durationSeconds > MAX_SEGMENT_DURATION_SECONDS) {
      dropReason = 'segment_too_long'
    } else if (text.length > MAX_SEGMENT_CHARACTERS) {
      dropReason = 'segment_too_large'
    } else if (looksHighlyRepetitive(text)) {
      dropReason = 'segment_repetitive'
    }

    if (dropReason) {
      droppedSegments.push(segment)
      droppedReasons.push(dropReason)
      continue
    }

    usableSegments.push(segment)
    totalWordCount += countWords(text)
  }

  return {
    usableSegments,
    droppedSegments,
    droppedReasons,
    totalWordCount,
    usable: usableSegments.length >= MIN_USABLE_SEGMENTS && totalWordCount >= MIN_USABLE_WORDS,
  }
}
