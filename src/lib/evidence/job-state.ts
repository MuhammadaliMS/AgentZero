export const EVIDENCE_JOB_STAGES = ['ingest', 'analyze', 'finalize'] as const

export type EvidenceJobStage = typeof EVIDENCE_JOB_STAGES[number]
export type EvidenceJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export function getNextEvidenceJobStage(stage: EvidenceJobStage): EvidenceJobStage | null {
  const index = EVIDENCE_JOB_STAGES.indexOf(stage)
  if (index === -1 || index === EVIDENCE_JOB_STAGES.length - 1) return null
  return EVIDENCE_JOB_STAGES[index + 1]
}

export function isTerminalEvidenceJobStatus(status: EvidenceJobStatus): boolean {
  return status === 'completed' || status === 'failed'
}
