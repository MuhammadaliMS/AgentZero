import { describe, expect, it } from 'vitest'

import {
  buildSourceArtifactVaultPath,
  buildVaultTree,
  renderSourceArtifactDocument,
  slugifyVaultSegment,
} from '@/lib/evidence/vault'

describe('slugifyVaultSegment', () => {
  it('creates stable vault-safe slugs', () => {
    expect(slugifyVaultSegment('Crane <> KeyValue / Intro Call')).toBe('crane-keyvalue-intro-call')
  })
})

describe('buildSourceArtifactVaultPath', () => {
  it('places meetings inside the Sources/Meetings folder with a dated filename', () => {
    const path = buildSourceArtifactVaultPath({
      channel: 'meeting',
      title: 'Crane Intro Call',
      startedAt: '2026-03-10T10:00:00.000Z',
      externalId: 'meeting-123',
    })

    expect(path).toBe('Sources/Meetings/2026-03-10-crane-intro-call.md')
  })
})

describe('renderSourceArtifactDocument', () => {
  it('renders a source artifact document with evidence excerpts and source metadata', () => {
    const rendered = renderSourceArtifactDocument({
      artifact: {
        id: 'artifact-1',
        orgId: 'org-1',
        channel: 'meeting',
        externalId: 'meeting-123',
        title: 'Crane Intro Call',
        sourceUrl: 'https://meet.google.com/test',
        startedAt: '2026-03-10T10:00:00.000Z',
        endedAt: '2026-03-10T10:30:00.000Z',
        rawRef: 'meeting:meeting-123',
        metadata: {
          participants: [
            { name: 'Max Chapman', email: 'max@crane.vc' },
          ],
        },
      },
      evidenceItems: [
        {
          id: 'ev-1',
          artifactId: 'artifact-1',
          orgId: 'org-1',
          sequenceNo: 1,
          authorName: 'Max Chapman',
          authorEntityId: null,
          happenedAt: '2026-03-10T10:00:23.000Z',
          text: 'We want a requirements document before the next step.',
          sourceAnchor: 'segment:seg-1',
          metadata: {
            startTime: 23,
          },
        },
      ],
    })

    expect(rendered.frontmatter.artifactId).toBe('artifact-1')
    expect(rendered.contentMarkdown).toContain('# Crane Intro Call')
    expect(rendered.contentMarkdown).toContain('## Evidence')
    expect(rendered.contentMarkdown).toContain('Max Chapman')
    expect(rendered.links).toEqual([
      { linkKind: 'artifact', targetId: 'artifact-1' },
      { linkKind: 'evidence_item', targetId: 'ev-1' },
    ])
  })
})

describe('buildVaultTree', () => {
  it('groups generated documents into a navigable folder tree', () => {
    const tree = buildVaultTree([
      'Sources/Meetings/2026-03-10-crane-intro-call.md',
      'Knowledge/Organizations/crane-ventures.md',
      'Work/Action Items/send-rate-card.md',
    ])

    expect(tree).toEqual([
      {
        name: 'Knowledge',
        path: 'Knowledge',
        type: 'folder',
        children: [
          {
            name: 'Organizations',
            path: 'Knowledge/Organizations',
            type: 'folder',
            children: [
              {
                name: 'crane-ventures.md',
                path: 'Knowledge/Organizations/crane-ventures.md',
                type: 'document',
              },
            ],
          },
        ],
      },
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
                name: '2026-03-10-crane-intro-call.md',
                path: 'Sources/Meetings/2026-03-10-crane-intro-call.md',
                type: 'document',
              },
            ],
          },
        ],
      },
      {
        name: 'Work',
        path: 'Work',
        type: 'folder',
        children: [
          {
            name: 'Action Items',
            path: 'Work/Action Items',
            type: 'folder',
            children: [
              {
                name: 'send-rate-card.md',
                path: 'Work/Action Items/send-rate-card.md',
                type: 'document',
              },
            ],
          },
        ],
      },
    ])
  })
})
