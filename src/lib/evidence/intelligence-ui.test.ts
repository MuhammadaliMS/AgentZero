import { describe, expect, it } from 'vitest'

import {
  flattenVaultDocumentPaths,
  summarizeArtifactChannels,
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
