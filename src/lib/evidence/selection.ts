import type { EvidenceItem } from '@/lib/evidence/types'
import type { NormalizedEvidenceItem } from '@/lib/evidence/normalizers'

type SelectableEvidence = Pick<EvidenceItem, 'id' | 'sequenceNo' | 'text' | 'authorName' | 'happenedAt' | 'sourceAnchor' | 'metadata'>
type SelectableNormalizedEvidence = Pick<NormalizedEvidenceItem, 'sequenceNo' | 'text' | 'authorName' | 'happenedAt' | 'sourceAnchor' | 'metadata'>

export const PROMPT_EVIDENCE_LIMIT = Math.max(Number(process.env.EVIDENCE_PROMPT_MAX_ITEMS) || 40, 8)
export const SYNC_EVIDENCE_EMBEDDING_LIMIT = Math.max(Number(process.env.EVIDENCE_EMBEDDING_SYNC_MAX_ITEMS) || 48, 0)

export function selectEvidenceForPrompt(input: {
  artifactTitle: string
  evidenceItems: SelectableEvidence[]
  sourceSummary?: Record<string, unknown> | null
  maxItems?: number
}): SelectableEvidence[] {
  return selectRepresentativeEvidence(input.evidenceItems, {
    artifactTitle: input.artifactTitle,
    sourceSummary: input.sourceSummary ?? null,
    maxItems: input.maxItems ?? PROMPT_EVIDENCE_LIMIT,
  })
}

export function selectEvidenceForEmbedding(
  evidenceItems: NormalizedEvidenceItem[],
  options?: {
    artifactTitle?: string
    sourceSummary?: Record<string, unknown> | null
    maxItems?: number
  }
): NormalizedEvidenceItem[] {
  const maxItems = options?.maxItems ?? SYNC_EVIDENCE_EMBEDDING_LIMIT
  if (maxItems <= 0) return []

  return selectRepresentativeEvidence(evidenceItems, {
    artifactTitle: options?.artifactTitle ?? '',
    sourceSummary: options?.sourceSummary ?? null,
    maxItems,
  })
}

function selectRepresentativeEvidence<T extends { sequenceNo: number; text: string; sourceAnchor: string; metadata?: Record<string, unknown> | null }>(
  evidenceItems: T[],
  options: {
    artifactTitle: string
    sourceSummary?: Record<string, unknown> | null
    maxItems: number
  }
): T[] {
  if (evidenceItems.length <= options.maxItems) {
    return [...evidenceItems]
  }

  const selected = new Map<string, T>()
  const ordered = [...evidenceItems].sort((a, b) => a.sequenceNo - b.sequenceNo)
  const terms = extractSalientTerms(options.artifactTitle, options.sourceSummary)

  addRange(selected, ordered.slice(0, Math.min(4, ordered.length)))
  addRange(selected, ordered.slice(Math.max(ordered.length - 4, 0)))

  const remainingBudget = Math.max(options.maxItems - selected.size, 0)
  if (remainingBudget === 0) {
    return finalizeSelection(selected, ordered)
  }

  const candidates = ordered
    .filter(item => !selected.has(item.sourceAnchor))
    .map(item => ({
      item,
      score: scoreEvidence(item.text, item.sequenceNo, ordered.length, terms),
    }))
    .sort((left, right) => right.score - left.score || left.item.sequenceNo - right.item.sequenceNo)

  const salientBudget = Math.min(Math.ceil(options.maxItems * 0.35), remainingBudget)
  addRange(selected, candidates.slice(0, salientBudget).map(candidate => candidate.item))

  if (selected.size < options.maxItems) {
    const evenlySpacedBudget = options.maxItems - selected.size
    const remaining = ordered.filter(item => !selected.has(item.sourceAnchor))
    addRange(selected, pickEvenlySpaced(remaining, evenlySpacedBudget))
  }

  return finalizeSelection(selected, ordered)
}

function addRange<T extends { sourceAnchor: string }>(target: Map<string, T>, items: T[]): void {
  for (const item of items) {
    target.set(item.sourceAnchor, item)
  }
}

function finalizeSelection<T extends { sourceAnchor: string; sequenceNo: number }>(selected: Map<string, T>, ordered: T[]): T[] {
  return [...selected.values()]
    .sort((left, right) => left.sequenceNo - right.sequenceNo)
    .filter(item => ordered.some(candidate => candidate.sourceAnchor === item.sourceAnchor))
}

function scoreEvidence(text: string, sequenceNo: number, totalCount: number, terms: string[]): number {
  const normalized = text.toLowerCase()
  const termHits = terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0)
  const densityBonus = Math.min(normalized.length / 240, 1)
  const position = totalCount > 1 ? sequenceNo / totalCount : 0
  const middleBonus = 1 - Math.abs(0.5 - position)

  return (termHits * 4) + densityBonus + middleBonus
}

function pickEvenlySpaced<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return []
  if (items.length <= count) return items

  const picks: T[] = []
  for (let index = 0; index < count; index += 1) {
    const position = Math.floor((index * (items.length - 1)) / Math.max(count - 1, 1))
    picks.push(items[position]!)
  }
  return picks
}

function extractSalientTerms(artifactTitle: string, sourceSummary?: Record<string, unknown> | null): string[] {
  const terms = new Set<string>()
  const titleWords = artifactTitle
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .filter(word => word.length >= 4)

  for (const word of titleWords) {
    terms.add(word)
  }

  const summaryStrings = collectSummaryStrings(sourceSummary)
  for (const value of summaryStrings) {
    const words = value
      .toLowerCase()
      .split(/[^a-z0-9@.]+/)
      .filter(word => word.length >= 4)
    for (const word of words) {
      terms.add(word)
    }
  }

  return [...terms]
}

function collectSummaryStrings(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => collectSummaryStrings(item))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(item => collectSummaryStrings(item))
  }
  return []
}
