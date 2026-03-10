import { describe, expect, it } from 'vitest'

import {
  buildClaimKey,
  normalizeChatArtifact,
  normalizeMeetingArtifact,
} from '@/lib/evidence/normalizers'
import { mutationBundleSchema } from '@/lib/evidence/schema'

describe('normalizeMeetingArtifact', () => {
  it('creates a canonical meeting artifact and evidence items from transcript segments', () => {
    const normalized = normalizeMeetingArtifact({
      orgId: 'org-1',
      meeting: {
        id: 'meeting-123',
        title: 'Crane Intro',
        scheduled_start: '2026-03-10T10:00:00.000Z',
        actual_end: '2026-03-10T10:36:00.000Z',
        meeting_url: 'https://meet.google.com/test',
        participants: [
          { name: 'Max Chapman', email: 'max@crane.vc' },
          { name: 'Muhammadali Bayramov', email: 'muhammadali@keyvalue.systems' },
        ],
      },
      segments: [
        {
          id: 'seg-1',
          speaker: 'Max Chapman',
          text: 'We want a requirements document before the next step.',
          start_time: 23,
          end_time: 31,
          created_at: '2026-03-10T10:00:23.000Z',
        },
        {
          id: 'seg-2',
          speaker: 'Muhammadali Bayramov',
          text: 'We can send that by Thursday.',
          start_time: 32,
          end_time: 38,
          created_at: '2026-03-10T10:00:32.000Z',
        },
      ],
    })

    expect(normalized.artifact.channel).toBe('meeting')
    expect(normalized.artifact.externalId).toBe('meeting-123')
    expect(normalized.artifact.title).toBe('Crane Intro')
    expect(normalized.artifact.sourceUrl).toBe('https://meet.google.com/test')
    expect(normalized.evidenceItems).toHaveLength(2)
    expect(normalized.evidenceItems[0]).toMatchObject({
      sequenceNo: 1,
      authorName: 'Max Chapman',
      sourceAnchor: 'segment:seg-1',
      text: 'We want a requirements document before the next step.',
    })
    expect(normalized.evidenceItems[0]?.metadata).toMatchObject({
      meetingId: 'meeting-123',
      segmentId: 'seg-1',
      endTime: 31,
    })
  })
})

describe('normalizeChatArtifact', () => {
  it('creates evidence items for chat turns and tool outputs', () => {
    const normalized = normalizeChatArtifact({
      orgId: 'org-1',
      conversation: {
        id: 'conv-1',
        title: 'Crane follow up',
        created_at: '2026-03-11T09:00:00.000Z',
        updated_at: '2026-03-11T09:15:00.000Z',
      },
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Summarize my latest Crane meeting.',
          created_at: '2026-03-11T09:00:00.000Z',
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Crane asked for a requirements document and a rate card.',
          created_at: '2026-03-11T09:00:15.000Z',
        },
      ],
      toolOutputs: [
        {
          toolName: 'read_slack_thread',
          output: '{"channel":"#deals","thread_ts":"171000.0001","messages":[{"text":"Max asked for the requirements document"}]}',
        },
      ],
    })

    expect(normalized.artifact.channel).toBe('chat')
    expect(normalized.evidenceItems).toHaveLength(3)
    expect(normalized.evidenceItems[2]).toMatchObject({
      artifactChannel: 'slack',
      authorName: 'tool:read_slack_thread',
      sourceAnchor: 'tool:read_slack_thread:1',
    })
  })
})

describe('buildClaimKey', () => {
  it('builds a stable key for the same claim content', () => {
    const one = buildClaimKey({
      orgId: 'org-1',
      claimKind: 'relationship',
      subjectEntityId: 'subj-1',
      predicate: 'owns',
      objectEntityId: 'obj-1',
      objectValue: null,
      artifactId: 'artifact-1',
    })
    const two = buildClaimKey({
      orgId: 'org-1',
      claimKind: 'relationship',
      subjectEntityId: 'subj-1',
      predicate: 'owns',
      objectEntityId: 'obj-1',
      objectValue: null,
      artifactId: 'artifact-1',
    })

    expect(one).toBe(two)
  })
})

describe('mutationBundleSchema', () => {
  it('rejects canonical claim mutations without evidence unless marked manual', () => {
    const result = mutationBundleSchema.safeParse({
      version: 1,
      source: 'channel_analyst',
      entities: [],
      claims: [
        {
          claimKind: 'relationship',
          predicate: 'owns',
          subjectEntityRef: 'entity:max',
          objectEntityRef: 'entity:doc',
          confidence: 0.82,
          evidenceItemRefs: [],
          manualStateInput: false,
        },
      ],
      memories: [],
      decisionThreads: [],
      commitments: [],
      vaultDocuments: [],
    })

    expect(result.success).toBe(false)
  })
})
