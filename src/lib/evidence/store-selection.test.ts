import { describe, expect, it } from 'vitest'

import type { NormalizedEvidenceItem } from '@/lib/evidence/normalizers'

function makeNormalizedEvidenceItems(count: number): NormalizedEvidenceItem[] {
  return Array.from({ length: count }, (_, index) => ({
    sequenceNo: index + 1,
    authorName: index % 2 === 0 ? 'Max Chapman' : 'Muhammadali Bayramov',
    happenedAt: `2026-03-10T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    text: index === 25
      ? 'Crane asked for the requirements document and diligence package.'
      : `Segment ${index + 1}`,
    sourceAnchor: `segment:${index + 1}`,
    artifactChannel: 'meeting',
    metadata: {
      startTime: index * 30,
      endTime: (index * 30) + 25,
    },
  }))
}

describe('selectEvidenceItemsForEmbedding', () => {
  it('caps synchronous evidence embeddings while keeping representative meeting segments', async () => {
    const { selectEvidenceItemsForEmbedding } = await import('@/lib/evidence/store')

    const selected = selectEvidenceItemsForEmbedding(makeNormalizedEvidenceItems(200), {
      artifactTitle: 'Crane <> KeyValue',
      sourceSummary: {
        summary: {
          tldr: 'Crane asked for the requirements document and diligence package.',
        },
      },
    })

    expect(selected.length).toBeLessThanOrEqual(48)
    expect(selected.some(item => item.sequenceNo === 1)).toBe(true)
    expect(selected.some(item => item.sequenceNo === 200)).toBe(true)
    expect(selected.some(item => item.sequenceNo === 26)).toBe(true)
  })
})
