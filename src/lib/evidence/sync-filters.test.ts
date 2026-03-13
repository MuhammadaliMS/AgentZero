import { describe, expect, it } from 'vitest'

import {
  isRelevantEmailMessage,
  isRelevantSlackConversation,
} from '@/lib/evidence/sync-filters'
import { extractChiefFocusProfile } from '@/lib/intelligence/focus-profile'
import {
  normalizeEmailArtifact,
  normalizeSlackArtifact,
} from '@/lib/evidence/normalizers'

describe('isRelevantEmailMessage', () => {
  it('rejects promotional newsletter-style email', () => {
    expect(isRelevantEmailMessage({
      subject: 'Top 10 AI tools this week',
      from: 'Substack <newsletter@substack.com>',
      labels: ['Promotions'],
      snippet: 'Read this week’s roundup and sponsored posts',
      body: 'unsubscribe | manage preferences',
    })).toBe(false)
  })

  it('keeps work-relevant email in the inbox', () => {
    expect(isRelevantEmailMessage({
      subject: 'Crane follow-up on requirements document',
      from: 'Max Chapman <max@crane.vc>',
      labels: ['Inbox', 'Important'],
      snippet: 'Can you send the requirements document and rate card today?',
      body: 'Need this before the partner discussion.',
    })).toBe(true)
  })

  it('suppresses deprioritized-only project email when a focus profile exists', () => {
    const focusProfile = extractChiefFocusProfile({
      chief_focus_topics: ['Crane'],
      chief_deprioritized_topics: ['Axari'],
    })

    expect(isRelevantEmailMessage({
      subject: 'Axari sprint planning',
      from: 'team@axari.com',
      labels: ['Inbox', 'Important'],
      snippet: 'Roadmap discussion for the internal product sprint',
      body: 'Please review the Axari backlog.',
    }, focusProfile)).toBe(false)
  })
})

describe('isRelevantSlackConversation', () => {
  it('keeps DMs and active work channels', () => {
    expect(isRelevantSlackConversation({
      channelType: 'dm',
      participantEmails: ['max@crane.vc'],
      messages: [
        { user: 'Max Chapman', text: 'Can you send the latest deck?' },
      ],
    })).toBe(true)

    expect(isRelevantSlackConversation({
      channelType: 'public',
      participantEmails: [],
      messages: [
        { user: 'you', text: 'Pushing the Crane follow-up today' },
        { user: 'Roy', text: 'Please include the requirements doc' },
      ],
    })).toBe(true)
  })

  it('suppresses deprioritized-only slack chatter when a focus profile exists', () => {
    const focusProfile = extractChiefFocusProfile({
      chief_focus_topics: ['Crane'],
      chief_deprioritized_topics: ['Axari'],
    })

    expect(isRelevantSlackConversation({
      channelType: 'public',
      participantEmails: [],
      messages: [
        { user: 'you', text: 'Axari sprint review moved to 4 PM' },
      ],
    }, focusProfile)).toBe(false)
  })
})

describe('normalizeEmailArtifact', () => {
  it('creates a stable thread artifact and evidence items', () => {
    const normalized = normalizeEmailArtifact({
      orgId: 'org-1',
      provider: 'gmail',
      thread: {
        id: 'thread-123',
        subject: 'Crane follow-up',
        participants: ['max@crane.vc', 'muhammadali@keyvalue.systems'],
        sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/thread-123',
      },
      messages: [
        {
          id: 'msg-1',
          authorName: 'Max Chapman',
          authorEmail: 'max@crane.vc',
          text: 'Can you send the requirements document?',
          happenedAt: '2026-03-11T09:00:00.000Z',
        },
      ],
    })

    expect(normalized.artifact.channel).toBe('email')
    expect(normalized.artifact.externalId).toBe('gmail:thread-123')
    expect(normalized.evidenceItems[0]?.sourceAnchor).toBe('message:msg-1')
  })
})

describe('normalizeSlackArtifact', () => {
  it('creates a stable thread artifact keyed by channel and thread timestamp', () => {
    const normalized = normalizeSlackArtifact({
      orgId: 'org-1',
      conversation: {
        channelId: 'C123',
        channelName: 'crane-deal',
        channelType: 'public',
        threadTs: '1741680123.000200',
        sourceUrl: 'https://example.slack.com/archives/C123/p1741680123000200',
      },
      messages: [
        {
          ts: '1741680123.000200',
          userName: 'Muhammadali Bayramov',
          userEmail: 'muhammadali@keyvalue.systems',
          text: 'I’ll send the rate card today.',
          happenedAt: '2026-03-11T10:22:03.000Z',
        },
      ],
    })

    expect(normalized.artifact.channel).toBe('slack')
    expect(normalized.artifact.externalId).toBe('slack:C123:1741680123.000200')
    expect(normalized.evidenceItems[0]?.artifactChannel).toBe('slack')
  })
})
