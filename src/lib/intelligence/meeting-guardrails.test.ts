import { describe, expect, it } from 'vitest'
import {
  computeMeetingDurationCapSeconds,
  getAbsurdRecordingReason,
  getStaleMeetingDecision,
  isGuardrailFailure,
  sanitizeTranscriptSegments,
} from './meeting-guardrails'

describe('computeMeetingDurationCapSeconds', () => {
  it('allows reasonable overrun based on scheduled duration without permitting absurd sessions', () => {
    const cap = computeMeetingDurationCapSeconds({
      scheduled_start: '2026-03-11T15:00:00.000Z',
      scheduled_end: '2026-03-11T15:45:00.000Z',
    })

    expect(cap).toBe(8100)
  })
})

describe('getAbsurdRecordingReason', () => {
  it('flags recordings that exceed the intelligent cap', () => {
    const reason = getAbsurdRecordingReason(
      {
        scheduled_start: '2026-03-11T15:00:00.000Z',
        scheduled_end: '2026-03-11T15:45:00.000Z',
        actual_start: '2026-03-11T15:24:00.000Z',
      },
      64_882,
      new Date('2026-03-12T09:28:00.000Z')
    )

    expect(reason).toContain('absurd_duration')
    expect(isGuardrailFailure(reason)).toBe(true)
  })
})

describe('getStaleMeetingDecision', () => {
  it('fails scheduled meetings that were never joined', () => {
    const decision = getStaleMeetingDecision(
      {
        status: 'scheduled',
        scheduled_start: '2026-03-12T07:30:00.000Z',
        updated_at: '2026-03-12T08:28:10.000Z',
        summary_ready: false,
      },
      new Date('2026-03-12T09:00:00.000Z')
    )

    expect(decision?.skipReason).toBe('Meeting was not joined in time')
  })

  it('fails recordings that run beyond the intelligent cap', () => {
    const decision = getStaleMeetingDecision(
      {
        status: 'recording',
        scheduled_start: '2026-03-11T15:00:00.000Z',
        scheduled_end: '2026-03-11T15:45:00.000Z',
        actual_start: '2026-03-11T15:24:38.000Z',
        updated_at: '2026-03-12T09:27:53.000Z',
        duration_seconds: 64_882,
        summary_ready: false,
      },
      new Date('2026-03-12T09:28:00.000Z')
    )

    expect(decision?.reason).toContain('absurd_duration')
    expect(decision?.setActualEnd).toBe(true)
  })
})

describe('sanitizeTranscriptSegments', () => {
  it('drops absurd long or repetitive segments and keeps usable dialogue', () => {
    const result = sanitizeTranscriptSegments([
      {
        speaker: 'Unknown',
        text: 'you',
        start_time: 0,
        end_time: 0.62,
        confidence: 0.4,
      },
      {
        speaker: 'Unknown',
        text: 'Thanks everyone for joining. We should switch to Zoom for the demo and follow up tomorrow with the API options.',
        start_time: 2,
        end_time: 18,
        confidence: 0.9,
      },
      {
        speaker: 'Unknown',
        text: 'Max will send the Zoom link and Muhammadali will review Spectre and AlphaSense before next week.',
        start_time: 20,
        end_time: 34,
        confidence: 0.9,
      },
      {
        speaker: 'Unknown',
        text: `${'Chris Montfort Robinhood Jonathan See Pepperdine University Yael Burla Vimeo JK Krug Equifax Alex Mandrusiak ATB Financial '.repeat(80)}`,
        start_time: 36,
        end_time: 64_876.695,
        confidence: 0.1,
      },
      {
        speaker: 'Unknown',
        text: 'Anna and Roy confirmed they will join the next call once the workflow demo is ready.',
        start_time: 40,
        end_time: 54,
        confidence: 0.88,
      },
    ])

    expect(result.usable).toBe(true)
    expect(result.usableSegments).toHaveLength(4)
    expect(result.droppedSegments).toHaveLength(1)
    expect(result.droppedReasons).toContain('segment_too_long')
  })

  it('marks a transcript unusable when only junk remains', () => {
    const repetitive = 'Chris Montfort Robinhood Jonathan See Pepperdine University Yael Burla Vimeo JK Krug Equifax Alex Mandrusiak ATB Financial '

    const result = sanitizeTranscriptSegments([
      {
        speaker: 'Unknown',
        text: 'you',
        start_time: 0,
        end_time: 0.62,
        confidence: 0.4,
      },
      {
        speaker: 'Unknown',
        text: repetitive.repeat(70),
        start_time: 2,
        end_time: 64_876.695,
        confidence: 0.1,
      },
    ])

    expect(result.usable).toBe(false)
    expect(result.droppedSegments).toHaveLength(1)
  })
})
