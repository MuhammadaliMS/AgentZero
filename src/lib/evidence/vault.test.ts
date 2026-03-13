import { describe, expect, it } from 'vitest'

import {
  buildBriefVaultPath,
  buildNarrativeVaultPath,
  buildSourceArtifactVaultPath,
  buildVaultTree,
  createManualSections,
  renderBriefDocument,
  renderNarrativeDocument,
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
    expect(rendered.renderStrategy).toBe('llm_assisted')
    expect(rendered.sections[0]?.title).toBe('Source metadata')
    expect(rendered.contentMarkdown).toContain('# Crane Intro Call')
    expect(rendered.contentMarkdown).toContain('## Chronology')
    expect(rendered.contentMarkdown).toContain('Max Chapman')
    expect(rendered.links).toEqual([
      expect.objectContaining({ linkKind: 'artifact', targetId: 'artifact-1' }),
      expect.objectContaining({ linkKind: 'evidence_item', targetId: 'ev-1' }),
    ])
  })
})

describe('narrative and brief rendering', () => {
  it('creates account narratives with persistent manual sections', () => {
    const rendered = renderNarrativeDocument({
      title: 'Crane Ventures',
      kind: 'account',
      sections: [
        {
          id: 'current-state',
          title: 'Current state',
          kind: 'narrative',
          content: 'Crane is in active diligence with KeyValue.',
          generated: true,
          editable: false,
        },
      ],
      previousManualSections: createManualSections({
        manual_notes: {
          key: 'manual_notes',
          title: 'Manual notes',
          content: 'Follow up on valuation sensitivity.',
        },
      }),
    })

    expect(rendered.path).toBe('Narratives/Accounts/crane-ventures.md')
    expect(rendered.sourceMode).toBe('hybrid')
    expect(rendered.manualSections.manual_notes?.content).toContain('valuation sensitivity')
  })

  it('creates daily brief documents in the Briefs folder', () => {
    const rendered = renderBriefDocument({
      title: 'Daily Brief 2026-03-13',
      dateKey: '2026-03-13',
      sections: [
        {
          id: 'today',
          title: 'Today at a glance',
          kind: 'brief',
          content: 'Crane moved forward and one at-risk action item surfaced.',
          generated: true,
          editable: false,
        },
      ],
    })

    expect(buildBriefVaultPath({ dateKey: '2026-03-13' })).toBe('Briefs/2026-03-13.md')
    expect(buildNarrativeVaultPath('Crane <> KeyValue', 'relationship')).toBe('Narratives/Relationships/crane-keyvalue.md')
    expect(rendered.documentType).toBe('brief')
    expect(rendered.contentMarkdown).toContain('Today at a glance')
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
