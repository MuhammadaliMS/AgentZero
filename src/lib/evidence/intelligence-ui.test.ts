import { describe, expect, it } from 'vitest'

import {
  buildAccountWorkspaceSummary,
  buildEvidenceFeed,
  buildIntelligenceNowSummary,
  describeInitiativeState,
  dedupeEntryPoints,
  explainInitiativePriority,
  findChangedDocsForInitiative,
  findRelatedDocsForInitiative,
  flattenVaultDocumentPaths,
  groupEntryPointsByFreshness,
  labelDocumentType,
  prioritizeInitiatives,
  summarizeInitiativeManualContext,
  summarizeArtifactChannels,
  type ChiefOperationalMemoryLike,
  type IntelligenceInitiativeEntry,
  type IntelligenceNowSummary,
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
          summary: 'Crane is progressing through scoping.',
          manualSectionSummaries: ['User wants to keep this relationship warm.'],
        },
        {
          path: 'Knowledge/Organizations/axari.md',
          title: 'Axari',
          documentType: 'entity',
          updatedAt: '2026-03-13T08:05:00.000Z',
          lastSourceUpdateAt: null,
          summary: null,
          manualSectionSummaries: [],
        },
      ]
    )

    expect(docs).toEqual([
      expect.objectContaining({ title: 'Crane Ventures' }),
    ])
  })
})

describe('findChangedDocsForInitiative', () => {
  it('prefers docs updated after the last initiative review point', () => {
    const docs = findChangedDocsForInitiative(
      {
        lastSignalAt: '2026-03-13T07:00:00.000Z',
        lastReconciledAt: '2026-03-13T07:30:00.000Z',
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
          path: 'Sources/Meetings/old.md',
          title: 'Older meeting',
          documentType: 'source_artifact',
          updatedAt: '2026-03-13T07:10:00.000Z',
          lastSourceUpdateAt: null,
        },
      ]
    )

    expect(docs).toHaveLength(1)
    expect(docs[0]?.title).toBe('Crane Ventures')
  })
})

describe('summarizeInitiativeManualContext', () => {
  it('collects deduped manual context snippets from related docs', () => {
    const snippets = summarizeInitiativeManualContext([
      {
        path: 'Narratives/Accounts/crane-ventures.md',
        title: 'Crane Ventures',
        documentType: 'narrative',
        updatedAt: '2026-03-13T08:10:00.000Z',
        lastSourceUpdateAt: null,
        manualSectionSummaries: [
          'User wants to keep this relationship warm.',
          'Need a cleaner screen-sharing flow.',
        ],
      },
      {
        path: 'Work/Action Items/crane-estimate.md',
        title: 'Crane estimate',
        documentType: 'commitment',
        updatedAt: '2026-03-13T08:15:00.000Z',
        lastSourceUpdateAt: null,
        manualSectionSummaries: [
          'User wants to keep this relationship warm.',
          'Commercials need sign-off.',
        ],
      },
    ])

    expect(snippets).toEqual([
      'User wants to keep this relationship warm.',
      'Need a cleaner screen-sharing flow.',
      'Commercials need sign-off.',
    ])
  })
})

describe('buildIntelligenceNowSummary', () => {
  const initiatives: IntelligenceInitiativeEntry[] = [
    {
      id: 'crane',
      title: 'Crane estimation',
      status: 'blocked',
      phase: 'execution',
      nextMilestone: 'Send estimate',
      nextReviewAt: '2026-03-13T07:00:00.000Z',
      lastSignalAt: '2026-03-13T06:30:00.000Z',
      latestSummary: 'Waiting for the final estimate package before sending Crane a response.',
      currentHypothesis: 'Crane is ready to move once the package is polished.',
      openQuestionCount: 2,
      riskCount: 1,
    },
    {
      id: 'axari',
      title: 'Axari handoff',
      status: 'waiting',
      phase: 'verification',
      nextMilestone: 'Confirm no more owner requests remain',
      nextReviewAt: '2026-03-15T09:00:00.000Z',
      lastSignalAt: '2026-03-12T10:00:00.000Z',
      latestSummary: 'Deprioritized but still receiving passive updates.',
      currentHypothesis: null,
      openQuestionCount: 0,
      riskCount: 0,
    },
  ]

  const entries: IntelligenceVaultEntryPoint[] = [
    {
      path: 'Narratives/Accounts/crane-ventures.md',
      title: 'Crane Ventures',
      documentType: 'narrative',
      updatedAt: '2026-03-13T07:10:00.000Z',
      lastSourceUpdateAt: '2026-03-13T07:00:00.000Z',
      summary: 'Crane estimation is blocked on the package review.',
    },
    {
      path: 'Sources/Meetings/2026-03-13-crane.md',
      title: 'Crane <> KeyValue',
      documentType: 'source_artifact',
      updatedAt: '2026-03-13T06:50:00.000Z',
      lastSourceUpdateAt: '2026-03-13T06:50:00.000Z',
      summary: 'Meeting generated new questions about estimate scope.',
    },
    {
      path: 'Work/Action Items/send-estimate.md',
      title: 'Send estimate package',
      documentType: 'commitment',
      updatedAt: '2026-03-13T07:05:00.000Z',
      lastSourceUpdateAt: '2026-03-13T07:05:00.000Z',
      summary: 'At risk until the package is ready.',
    },
  ]

  const operationalMemory: ChiefOperationalMemoryLike = {
    urgentCommitments: [
      {
        title: 'Send estimate package',
        status: 'at_risk',
      },
    ],
    blockedInitiatives: [
      {
        title: 'Crane estimation',
        reason: 'Final package not ready',
      },
    ],
  }

  it('builds an action-first summary for the Now screen', () => {
    const summary = buildIntelligenceNowSummary({
      initiatives,
      recentlyChanged: entries,
      jumpBackIn: entries,
      work: entries.filter((entry) => entry.documentType === 'commitment'),
      meetings: entries.filter((entry) => entry.documentType === 'source_artifact'),
      operationalMemory,
      now: '2026-03-13T07:30:00.000Z',
    })

    expect(summary.topPriorities[0]).toEqual(
      expect.objectContaining({
        title: 'Crane estimation',
      })
    )
    expect(summary.needsAttention[0]?.title).toContain('Crane estimation')
    expect(summary.blocked[0]?.reason).toContain('Final package not ready')
    expect(summary.waiting[0]?.title).toBe('Axari handoff')
    expect(summary.recentSources[0]?.documentType).toBe('source_artifact')
    expect(summary.whatChanged[0]?.title).toBe('Crane Ventures')
  })

  it('returns a stable empty state when there is no meaningful context yet', () => {
    const summary = buildIntelligenceNowSummary({
      initiatives: [],
      recentlyChanged: [],
      jumpBackIn: [],
      work: [],
      meetings: [],
      operationalMemory: null,
      now: '2026-03-13T07:30:00.000Z',
    })

    expect(summary).toEqual<IntelligenceNowSummary>({
      whatChanged: [],
      topPriorities: [],
      needsAttention: [],
      blocked: [],
      waiting: [],
      recentSources: [],
      evidenceUsed: [],
    })
  })
})

describe('buildAccountWorkspaceSummary', () => {
  it('prioritizes account narratives and keeps recent account changes scoped', () => {
    const summary = buildAccountWorkspaceSummary({
      accounts: [
        {
          path: 'Knowledge/Organizations/keyvalue.md',
          title: 'KeyValue Systems',
          documentType: 'entity',
          updatedAt: '2026-03-13T06:00:00.000Z',
          lastSourceUpdateAt: null,
        },
        {
          path: 'Narratives/Accounts/crane-ventures.md',
          title: 'Crane Ventures',
          documentType: 'narrative',
          updatedAt: '2026-03-13T07:00:00.000Z',
          lastSourceUpdateAt: null,
        },
      ],
      relationships: [
        {
          path: 'Narratives/Relationships/crane-keyvalue.md',
          title: 'Crane <> KeyValue',
          documentType: 'narrative',
          updatedAt: '2026-03-13T07:05:00.000Z',
          lastSourceUpdateAt: null,
        },
      ],
      recentlyChanged: [
        {
          path: 'Narratives/Relationships/crane-keyvalue.md',
          title: 'Crane <> KeyValue',
          documentType: 'narrative',
          updatedAt: '2026-03-13T07:05:00.000Z',
          lastSourceUpdateAt: null,
        },
        {
          path: 'Work/Action Items/send-estimate.md',
          title: 'Send estimate',
          documentType: 'commitment',
          updatedAt: '2026-03-13T07:10:00.000Z',
          lastSourceUpdateAt: null,
        },
      ],
    })

    expect(summary.featuredAccounts[0]?.title).toBe('Crane Ventures')
    expect(summary.relationshipDocs[0]?.title).toBe('Crane <> KeyValue')
    expect(summary.recentAccountChanges).toEqual([
      expect.objectContaining({ title: 'Crane <> KeyValue' }),
    ])
  })
})

describe('buildEvidenceFeed', () => {
  it('builds an explainability feed from source docs and touched work', () => {
    const feed = buildEvidenceFeed({
      meetings: [
        {
          path: 'Sources/Meetings/crane.md',
          title: 'Crane <> KeyValue',
          documentType: 'source_artifact',
          updatedAt: '2026-03-13T07:00:00.000Z',
          lastSourceUpdateAt: '2026-03-13T07:00:00.000Z',
          summary: 'Meeting expanded estimate scope.',
        },
      ],
      recentlyChanged: [
        {
          path: 'Sources/Meetings/crane.md',
          title: 'Crane <> KeyValue',
          documentType: 'source_artifact',
          updatedAt: '2026-03-13T07:00:00.000Z',
          lastSourceUpdateAt: '2026-03-13T07:00:00.000Z',
          summary: 'Meeting expanded estimate scope.',
        },
      ],
      work: [
        {
          path: 'Work/Action Items/send-estimate.md',
          title: 'Send estimate package',
          documentType: 'commitment',
          updatedAt: '2026-03-13T07:02:00.000Z',
          lastSourceUpdateAt: null,
          summary: 'Estimate package is now at risk.',
        },
      ],
    })

    expect(feed[0]).toEqual(
      expect.objectContaining({
        title: 'Crane <> KeyValue',
        supportingPath: 'Sources/Meetings/crane.md',
      })
    )
  })
})
