import { describe, expect, it } from 'vitest'

import {
  applyChiefFocusToItems,
  extractChiefFocusProfile,
  matchesChiefFocus,
} from '@/lib/intelligence/focus-profile'

describe('extractChiefFocusProfile', () => {
  it('reads focus settings from org settings', () => {
    const profile = extractChiefFocusProfile({
      chief_focus_topics: ['Crane Ventures', 'estimation work'],
      chief_deprioritized_topics: ['Axari', 'AI Spotlight'],
      chief_focus_instructions: 'Prioritize active client work over internal product chatter.',
    })

    expect(profile.priorityTopics).toEqual(['Crane Ventures', 'estimation work'])
    expect(profile.deprioritizedTopics).toEqual(['Axari', 'AI Spotlight'])
    expect(profile.instructions).toBe('Prioritize active client work over internal product chatter.')
  })

  it('normalizes empty settings to an inactive profile', () => {
    const profile = extractChiefFocusProfile({})

    expect(profile.priorityTopics).toEqual([])
    expect(profile.deprioritizedTopics).toEqual([])
    expect(profile.instructions).toBeNull()
    expect(profile.isActive).toBe(false)
  })
})

describe('matchesChiefFocus', () => {
  const profile = extractChiefFocusProfile({
    chief_focus_topics: ['Crane', 'KeyValue estimation'],
    chief_deprioritized_topics: ['Axari', 'AI Spotlight'],
  })

  it('identifies prioritized text', () => {
    const match = matchesChiefFocus('Need to send the Crane requirements document today.', profile)

    expect(match.prioritized).toBe(true)
    expect(match.deprioritized).toBe(false)
    expect(match.suppress).toBe(false)
  })

  it('suppresses deprioritized-only text', () => {
    const match = matchesChiefFocus('Axari sprint planning is in #ai-spotlight today.', profile)

    expect(match.prioritized).toBe(false)
    expect(match.deprioritized).toBe(true)
    expect(match.suppress).toBe(true)
  })

  it('keeps mixed text when it includes an active focus topic', () => {
    const match = matchesChiefFocus('Axari team asked whether Crane wants a Zoom link for the workflow demo.', profile)

    expect(match.prioritized).toBe(true)
    expect(match.deprioritized).toBe(true)
    expect(match.suppress).toBe(false)
  })
})

describe('applyChiefFocusToItems', () => {
  const profile = extractChiefFocusProfile({
    chief_focus_topics: ['Crane'],
    chief_deprioritized_topics: ['Axari'],
  })

  it('filters deprioritized items and sorts focused items first', () => {
    const result = applyChiefFocusToItems(
      [
        { id: '1', text: 'Axari standup today' },
        { id: '2', text: 'Crane follow-up on requirements doc' },
        { id: '3', text: 'General finance admin' },
      ],
      item => item.text,
      profile
    )

    expect(result.items.map(item => item.id)).toEqual(['2', '3'])
    expect(result.suppressedCount).toBe(1)
  })
})
