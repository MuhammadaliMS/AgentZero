import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EvidenceItem, SourceArtifact } from '@/lib/evidence/types'

const ORIGINAL_ENV = { ...process.env }

function makeMeetingArtifact(): SourceArtifact {
  return {
    id: 'artifact-1',
    orgId: 'org-1',
    channel: 'meeting',
    externalId: 'meeting-1',
    title: 'Crane <> KeyValue',
    sourceUrl: null,
    startedAt: '2026-03-10T10:00:00.000Z',
    endedAt: '2026-03-10T11:00:00.000Z',
    rawRef: 'meeting:meeting-1',
    metadata: {},
  }
}

function makeEvidenceItems(count: number): EvidenceItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `evidence-${index + 1}`,
    artifactId: 'artifact-1',
    orgId: 'org-1',
    sequenceNo: index + 1,
    authorName: index % 2 === 0 ? 'Max Chapman' : 'Muhammadali Bayramov',
    authorEntityId: null,
    happenedAt: `2026-03-10T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    text: index === 40
      ? 'We need a requirements document and a scoping call with Crane.'
      : index === 180
        ? 'Anna from Crane will own the diligence checklist and rate card follow-up.'
        : `Transcript segment ${index + 1}`,
    sourceAnchor: `segment:${index + 1}`,
    metadata: {
      startTime: index * 30,
      endTime: (index * 30) + 25,
    },
  }))
}

describe('getEvidenceAgentModels', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults both analyst and synthesizer to the extractor model on NVIDIA', async () => {
    process.env.NVIDIA_API_KEY = 'nvapi-test'
    delete process.env.AGENTIC_EVIDENCE_ANALYST_MODEL
    delete process.env.AGENTIC_EVIDENCE_SYNTHESIZER_MODEL
    delete process.env.AGENTIC_EVIDENCE_MODEL
    delete process.env.EXTRACTOR_MODEL

    const { getEvidenceAgentModels } = await import('@/lib/evidence/agents')

    expect(getEvidenceAgentModels()).toEqual({
      analystModel: 'qwen/qwen3.5-397b-a17b',
      synthesizerModel: 'qwen/qwen3.5-397b-a17b',
    })
  })
})

describe('selectEvidenceForAgentPrompt', () => {
  it('caps large meeting prompts while keeping early, mid, late, and salient evidence', async () => {
    const { selectEvidenceForAgentPrompt } = await import('@/lib/evidence/agents')

    const selected = selectEvidenceForAgentPrompt({
      artifact: makeMeetingArtifact(),
      evidenceItems: makeEvidenceItems(220),
      sourceSummary: {
        summary: {
          tldr: 'Crane asked for a requirements document and next-step scoping call.',
        },
        actionItems: [
          { text: 'Send requirements document to Crane.' },
          { text: 'Schedule scoping call.' },
        ],
        decisions: [],
      },
    })

    expect(selected.length).toBeLessThanOrEqual(40)
    expect(selected.some(item => item.id === 'evidence-1')).toBe(true)
    expect(selected.some(item => item.id === 'evidence-220')).toBe(true)
    expect(selected.some(item => item.id === 'evidence-41')).toBe(true)
    expect(selected.some(item => item.id === 'evidence-181')).toBe(true)
  })
})
