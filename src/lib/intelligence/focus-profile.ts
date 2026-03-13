export interface ChiefFocusProfile {
  priorityTopics: string[]
  deprioritizedTopics: string[]
  instructions: string | null
  isActive: boolean
}

interface FocusMatch {
  prioritized: boolean
  deprioritized: boolean
  suppress: boolean
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item ?? '').trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(/\n|,/)
      .map(item => item.trim())
      .filter(Boolean)
  }

  return []
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesTopic(text: string, topic: string): boolean {
  const normalizedText = normalize(text)
  const normalizedTopic = normalize(topic)
  return normalizedTopic.length > 0 && normalizedText.includes(normalizedTopic)
}

export function extractChiefFocusProfile(settings: Record<string, unknown> | null | undefined): ChiefFocusProfile {
  const priorityTopics = toStringArray(settings?.chief_focus_topics)
  const deprioritizedTopics = toStringArray(settings?.chief_deprioritized_topics)
  const rawInstructions = settings?.chief_focus_instructions
  const instructions = typeof rawInstructions === 'string' && rawInstructions.trim().length > 0
    ? rawInstructions.trim()
    : null

  return {
    priorityTopics,
    deprioritizedTopics,
    instructions,
    isActive: priorityTopics.length > 0 || deprioritizedTopics.length > 0 || Boolean(instructions),
  }
}

export function matchesChiefFocus(text: string, profile: ChiefFocusProfile): FocusMatch {
  const prioritized = profile.priorityTopics.some(topic => includesTopic(text, topic))
  const deprioritized = profile.deprioritizedTopics.some(topic => includesTopic(text, topic))

  return {
    prioritized,
    deprioritized,
    suppress: deprioritized && !prioritized,
  }
}

export function applyChiefFocusToItems<T>(
  items: T[],
  getText: (item: T) => string,
  profile: ChiefFocusProfile
): { items: T[]; suppressedCount: number } {
  if (!profile.isActive) {
    return { items, suppressedCount: 0 }
  }

  const kept: Array<{ item: T; score: number }> = []
  let suppressedCount = 0

  for (const item of items) {
    const match = matchesChiefFocus(getText(item), profile)
    if (match.suppress) {
      suppressedCount += 1
      continue
    }

    const score = match.prioritized ? 2 : 1
    kept.push({ item, score })
  }

  return {
    items: kept.sort((a, b) => b.score - a.score).map(entry => entry.item),
    suppressedCount,
  }
}

export function summarizeChiefFocusProfile(profile: ChiefFocusProfile): string | null {
  if (!profile.isActive) return null

  const parts: string[] = []

  if (profile.priorityTopics.length > 0) {
    parts.push(`Prioritize: ${profile.priorityTopics.join(', ')}`)
  }
  if (profile.deprioritizedTopics.length > 0) {
    parts.push(`Deprioritize: ${profile.deprioritizedTopics.join(', ')}`)
  }
  if (profile.instructions) {
    parts.push(`Guidance: ${profile.instructions}`)
  }

  return parts.join(' | ')
}
