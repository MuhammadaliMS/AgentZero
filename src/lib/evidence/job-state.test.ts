import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_JOB_STAGES,
  getNextEvidenceJobStage,
  isTerminalEvidenceJobStatus,
} from '@/lib/evidence/job-state'

describe('evidence job state', () => {
  it('advances stages in the expected order', () => {
    expect(EVIDENCE_JOB_STAGES).toEqual(['ingest', 'analyze', 'finalize'])
    expect(getNextEvidenceJobStage('ingest')).toBe('analyze')
    expect(getNextEvidenceJobStage('analyze')).toBe('finalize')
    expect(getNextEvidenceJobStage('finalize')).toBeNull()
  })

  it('treats completed and failed as terminal statuses', () => {
    expect(isTerminalEvidenceJobStatus('completed')).toBe(true)
    expect(isTerminalEvidenceJobStatus('failed')).toBe(true)
    expect(isTerminalEvidenceJobStatus('queued')).toBe(false)
    expect(isTerminalEvidenceJobStatus('processing')).toBe(false)
  })
})
