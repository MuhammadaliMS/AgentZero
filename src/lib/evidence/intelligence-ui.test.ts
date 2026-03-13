import { describe, expect, it } from 'vitest'

import {
  dedupeEntryPoints,
  flattenVaultDocumentPaths,
  groupEntryPointsByFreshness,
  labelDocumentType,
  summarizeArtifactChannels,
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
  })
})
