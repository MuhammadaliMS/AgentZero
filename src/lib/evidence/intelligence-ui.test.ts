import { describe, expect, it } from 'vitest'

import {
  describeInitiativeState,
  dedupeEntryPoints,
  explainInitiativePriority,
  findRelatedDocsForInitiative,
  flattenVaultDocumentPaths,
  groupEntryPointsByFreshness,
  labelDocumentType,
  prioritizeInitiatives,
  summarizeArtifactChannels,
  type IntelligenceInitiativeEntry,
  type IntelligenceVaultEntryPoint,
  type IntelligenceVaultTreeNode,
} from '@/lib/evidence/intelligence-ui'

describe('flattenVaultDocumentPaths', () => {
  it('returns document paths from nested vault folders in tree order', () => {
    const tree: IntelligenceVaultTreeNode[] = [
      {
        name: 'Sources',
        path: 'Sources',
        type: 'folder',
        children: [
          {
            name: 'Meetings',
            path: 'Sources/Meetings',
            type: 'folder',
            children: [
              {
                name: 'crane.md',
                path: 'Sources/Meetings/crane.md',
                type: 'document',
              },
            ],
          },
        ],
      },
      {
        name: 'Timelines',
        path: 'Timelines',
        type: 'folder',
        children: [
          {
            name: 'crane-timeline.md',
            path: 'Timelines/crane-timeline.md',
            type: 'document',
          },
        ],
      },
    ]

    expect(flattenVaultDocumentPaths(tree)).toEqual([
      'Sources/Meetings/crane.md',
      'Timelines/crane-timeline.md',
    ])
  })
})

describe('summarizeArtifactChannels', () => {
  it('formats channel counts in descending order with readable labels', () => {
    expect(
      summarizeArtifactChannels([
        'meeting',
        'email',
        'meeting',
        'slack',
        'chat',
        'email',
      ])
    ).toBe('2 meetings, 2 emails, 1 Slack, 1 chat')
  })

  it('falls back to an empty-state label when there are no channels', () => {
    expect(summarizeArtifactChannels([])).toBe('No synced sources yet')
  })
})

describe('groupEntryPointsByFreshness', () => {
  it('separates recently updated entry points from older ones', () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 6 * 3_600_000).toISOString()
    const stale = new Date(now.getTime() - 96 * 3_600_000).toISOString()
    const entries: IntelligenceVaultEntryPoint[] = [
      {
        path: 'Narratives/Accounts/crane.md',
        title: 'Crane',
        documentType: 'narrative',
        updatedAt: recent,
        lastSourceUpdateAt: recent,
      },
      {
        path: 'Knowledge/Organizations/keyvalue.md',
        title: 'KeyValue',
        documentType: 'entity',
        updatedAt: stale,
        lastSourceUpdateAt: stale,
      },
    ]

    const grouped = groupEntryPointsByFreshness(entries)
    expect(grouped.fresh).toHaveLength(1)
    expect(grouped.older).toHaveLength(1)
    expect(grouped.fresh[0]?.title).toBe('Crane')
  })
})

describe('dedupeEntryPoints', () => {
  it('keeps the newest entry per title and document type to avoid noisy repeats', () => {
    const entries: IntelligenceVaultEntryPoint[] = [
      {
        path: 'Knowledge/Organizations/axari.md',
        title: 'Axari',
        documentType: 'entity',
        updatedAt: '2026-03-13T04:10:00.000Z',
        lastSourceUpdateAt: null,
      },
      {
        path: 'Knowledge/Organizations/axari-copy.md',
        title: 'Axari',
        documentType: 'entity',
        updatedAt: '2026-03-13T04:20:00.000Z',
        lastSourceUpdateAt: null,
      },
      {
        path: 'Narratives/Accounts/axari.md',
        title: 'Axari',
        documentType: 'narrative',
        updatedAt: '2026-03-13T04:30:00.000Z',
        lastSourceUpdateAt: null,
      },
    ]

    expect(dedupeEntryPoints(entries)).toEqual([
      expect.objectContaining({ path: 'Narratives/Accounts/axari.md', documentType: 'narrative' }),
      expect.objectContaining({ path: 'Knowledge/Organizations/axari-copy.md', documentType: 'entity' }),
    ])
  })
})

describe('labelDocumentType', () => {
  it('uses readable labels for key vault doc types', () => {
    expect(labelDocumentType('decision_thread')).toBe('Decision')
    expect(labelDocumentType('commitment')).toBe('Action item')
    expect(labelDocumentType('brief')).toBe('Brief')
    expect(labelDocumentType('initiative')).toBe('Initiative')
  })
})

describe('prioritizeInitiatives', () => {
  it('surfaces blocked or due initiatives ahead of stale background work', () => {
    const entries: IntelligenceInitiativeEntry[] = [
      {
        id: 'axari',
        title: 'Axari internal platform',
        status: 'active',
        phase: 'planning',
        nextMilestone: 'Spec review',
        nextReviewAt: '2026-03-20T08:00:00.000Z',
        lastSignalAt: '2026-03-10T08:00:00.000Z',
        latestSummary: 'Background work',
        openQuestionCount: 0,
        riskCount: 0,
      },
      {
        id: 'crane',
        title: 'Crane estimation',
        status: 'blocked',
        phase: 'execution',
        nextMilestone: 'Send estimate',
        nextReviewAt: '2026-03-13T07:00:00.000Z',
        lastSignalAt: '2026-03-13T06:30:00.000Z',
        latestSummary: 'Waiting on the estimate package',
        openQuestionCount: 1,
        riskCount: 1,
      },
    ]

    const ranked = prioritizeInitiatives(entries, '2026-03-13T07:30:00.000Z')

    expect(ranked[0]?.id).toBe('crane')
  })
})

describe('describeInitiativeState', () => {
  it('summarizes the phase, milestone, and unresolved work', () => {
    expect(describeInitiativeState({
      id: 'crane',
      title: 'Crane estimation',
      status: 'active',
      phase: 'execution',
      nextMilestone: 'Send estimate',
      nextReviewAt: null,
      lastSignalAt: null,
      latestSummary: null,
      openQuestionCount: 2,
      riskCount: 1,
    })).toBe('execution · active · next: Send estimate · 2 open questions · 1 risk')
  })
})

describe('explainInitiativePriority', () => {
  it('explains why an initiative is on top of the stack', () => {
    const explanation = explainInitiativePriority({
      id: 'crane',
      title: 'Crane estimation',
      status: 'blocked',
      phase: 'execution',
      nextMilestone: 'Send estimate',
      nextReviewAt: '2026-03-13T07:00:00.000Z',
      lastSignalAt: null,
      latestSummary: null,
      openQuestionCount: 2,
      riskCount: 1,
    }, '2026-03-13T07:30:00.000Z')

    expect(explanation).toContain('blocked')
    expect(explanation).toContain('due for review')
    expect(explanation).toContain('Send estimate')
  })
})

describe('findRelatedDocsForInitiative', () => {
  it('matches vault docs to initiative title and summary', () => {
    const docs = findRelatedDocsForInitiative(
      {
        title: 'Crane estimation',
        latestSummary: 'Working with Crane Ventures on the estimate package.',
      },
      [
        {
          path: 'Narratives/Accounts/crane-ventures.md',
          title: 'Crane Ventures',
          documentType: 'narrative',
          updatedAt: '2026-03-13T08:10:00.000Z',
          lastSourceUpdateAt: null,
        },
        {
          path: 'Knowledge/Organizations/axari.md',
          title: 'Axari',
          documentType: 'entity',
          updatedAt: '2026-03-13T08:05:00.000Z',
          lastSourceUpdateAt: null,
        },
      ]
    )

    expect(docs).toEqual([
      expect.objectContaining({ title: 'Crane Ventures' }),
    ])
  })
})
