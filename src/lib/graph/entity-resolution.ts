import { isOpenAIConfigured, resolveEntityMatchWithLLM } from '@/lib/openai/client'

const PERSON_STRONG_THRESHOLD = 0.88
const ORG_STRONG_THRESHOLD = 0.9
const AMBIGUOUS_THRESHOLD = 0.72

const ORGANIZATION_SUFFIXES = new Set([
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'vc',
  'venture',
  'ventures',
])

export interface EntityMatchCandidate {
  id: string
  entityType: string
  name: string
  canonicalName: string
  mentionCount: number
  attributes?: Record<string, unknown> | null
  aliases?: string[]
}

export interface EntityMatchDecision {
  entityId: string
  score: number
  strategy: 'deterministic_strong' | 'deterministic_ambiguous' | 'llm'
  reason: string
}

interface ScoredEntityCandidate extends EntityMatchDecision {
  candidate: EntityMatchCandidate
}

interface ResolutionLookupResult {
  matchedEntity: EntityMatchCandidate | null
  decision: EntityMatchDecision | null
  candidates: EntityMatchCandidate[]
}

/**
 * Normalize a raw entity name into a comparison-safe form.
 */
export function normalizeEntityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}@.\s-]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build comparison variants for resolution. The first value is always the raw normalized form.
 */
export function buildResolutionVariants(name: string, entityType: string): string[] {
  const normalized = normalizeEntityName(name)
  if (!normalized) return []

  const variants = new Set<string>([normalized])
  const tokens = normalized.split(' ').filter(Boolean)

  if (entityType === 'person' && tokens.length >= 2) {
    variants.add(tokens.join(' '))
    variants.add(tokens.map(token => token.replace(/\./g, '')).join(' '))
  }

  if (isOrganizationLike(entityType) && tokens.length >= 2) {
    const baseTokens = tokens.filter(token => !ORGANIZATION_SUFFIXES.has(token))
    if (baseTokens.length > 0) {
      variants.add(baseTokens.join(' '))
    }
  }

  return [...variants]
}

/**
 * Extract a stable email identity if present.
 */
export function extractEntityEmail(attributes?: Record<string, unknown> | null): string | null {
  const email = attributes?.email
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null
}

/**
 * Compute a deterministic score for likely identity matches.
 */
export function scoreEntityMatch(
  candidate: EntityMatchCandidate,
  existing: EntityMatchCandidate
): EntityMatchDecision | null {
  if (candidate.entityType !== existing.entityType) {
    return null
  }

  const candidateEmail = extractEntityEmail(candidate.attributes)
  const existingEmail = extractEntityEmail(existing.attributes)

  if (candidateEmail && existingEmail && candidateEmail === existingEmail) {
    return {
      entityId: existing.id,
      score: 1,
      strategy: 'deterministic_strong',
      reason: 'exact email identity match',
    }
  }

  const candidateVariants = buildExactComparableVariants(candidate.name, candidate.entityType)
  const existingVariants = new Set<string>([
    ...buildExactComparableVariants(existing.name, existing.entityType),
    ...buildExactComparableVariants(existing.canonicalName, existing.entityType),
    ...(existing.aliases ?? []).flatMap(alias => buildExactComparableVariants(alias, existing.entityType)),
  ])

  for (const variant of candidateVariants) {
    if (existingVariants.has(variant)) {
      return {
        entityId: existing.id,
        score: 0.95,
        strategy: 'deterministic_strong',
        reason: 'exact normalized alias match',
      }
    }
  }

  if (candidate.entityType === 'person') {
    return scorePersonMatch(candidate, existing)
  }

  if (isOrganizationLike(candidate.entityType)) {
    return scoreOrganizationMatch(candidate, existing)
  }

  return scoreFallbackMatch(candidate, existing)
}

/**
 * Pick the best deterministic entity match when the score is strong enough.
 */
export function findBestDeterministicEntityMatch(input: {
  candidate: EntityMatchCandidate
  existing: EntityMatchCandidate[]
}): EntityMatchDecision | null {
  const scored = input.existing
    .map(existing => {
      const decision = scoreEntityMatch(input.candidate, existing)
      return decision ? { ...decision, candidate: existing } : null
    })
    .filter(Boolean)
    .sort(compareScoredMatches) as ScoredEntityCandidate[]

  if (scored.length === 0) return null

  const best = scored[0]
  const threshold = best.candidate.entityType === 'person'
    ? PERSON_STRONG_THRESHOLD
    : isOrganizationLike(best.candidate.entityType)
      ? ORG_STRONG_THRESHOLD
      : PERSON_STRONG_THRESHOLD

  if (best.score < threshold) {
    return null
  }

  return {
    entityId: best.entityId,
    score: best.score,
    strategy: 'deterministic_strong',
    reason: best.reason,
  }
}

/**
 * Ask the LLM to resolve a candidate against ambiguous near-matches when deterministic scoring is insufficient.
 */
export async function findAgenticEntityMatch(input: {
  candidate: EntityMatchCandidate
  existing: EntityMatchCandidate[]
}): Promise<EntityMatchDecision | null> {
  const scored = input.existing
    .map(existing => {
      const decision = scoreEntityMatch(input.candidate, existing)
      return decision ? { ...decision, candidate: existing } : null
    })
    .filter(Boolean)
    .sort(compareScoredMatches) as ScoredEntityCandidate[]

  const ambiguous = scored.filter(match => match.score >= AMBIGUOUS_THRESHOLD).slice(0, 5)
  if (ambiguous.length === 0 || !isOpenAIConfigured()) {
    return null
  }

  const llmDecision = await resolveEntityMatchWithLLM({
    candidate: serializeEntityForLLM(input.candidate),
    candidates: ambiguous.map(match => serializeEntityForLLM(match.candidate)),
  })

  if (!llmDecision || llmDecision.action !== 'match' || !llmDecision.entityId) {
    return null
  }

  const matched = ambiguous.find(match => match.candidate.id === llmDecision.entityId)
  if (!matched) return null

  return {
    entityId: matched.entityId,
    score: Math.max(matched.score, llmDecision.confidence ?? matched.score),
    strategy: 'llm',
    reason: llmDecision.reasoning || matched.reason,
  }
}

/**
 * Resolve a candidate against existing entities using aliases, deterministic scoring, and LLM fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveExistingEntityMatch(input: {
  supabase: any
  orgId: string
  candidate: Omit<EntityMatchCandidate, 'id' | 'mentionCount'>
}): Promise<ResolutionLookupResult> {
  const existing = await fetchResolutionCandidates(input)
  const candidate: EntityMatchCandidate = {
    id: 'candidate',
    mentionCount: 0,
    ...input.candidate,
    aliases: input.candidate.aliases ?? [],
  }

  const deterministic = findBestDeterministicEntityMatch({
    candidate,
    existing,
  })

  if (deterministic) {
    const matchedEntity = existing.find(entity => entity.id === deterministic.entityId) ?? null
    return {
      matchedEntity,
      decision: deterministic,
      candidates: existing,
    }
  }

  const agentic = await findAgenticEntityMatch({
    candidate,
    existing,
  })

  if (agentic) {
    const matchedEntity = existing.find(entity => entity.id === agentic.entityId) ?? null
    return {
      matchedEntity,
      decision: agentic,
      candidates: existing,
    }
  }

  return {
    matchedEntity: null,
    decision: null,
    candidates: existing,
  }
}

/**
 * Persist one or more aliases for a canonical entity. Variants share the same original alias source.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function upsertEntityAliases(input: {
  supabase: any
  orgId: string
  entityId: string
  entityType: string
  alias: string
  aliasKind: 'canonical' | 'observed' | 'llm_inferred' | 'merged'
  confidence?: number
  source?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  const variants = buildStoredAliasVariants(input.alias, input.entityType)
  if (variants.length === 0) return

  const rows = variants.map(variant => ({
    org_id: input.orgId,
    entity_id: input.entityId,
    entity_type: input.entityType,
    alias: input.alias,
    normalized_alias: variant,
    alias_kind: input.aliasKind,
    confidence: input.confidence ?? 1,
    source: input.source ?? null,
    metadata: input.metadata ?? {},
    updated_at: new Date().toISOString(),
  }))

  await input.supabase
    .from('entity_aliases')
    .upsert(rows, { onConflict: 'org_id,entity_id,normalized_alias' })
}

function scorePersonMatch(
  candidate: EntityMatchCandidate,
  existing: EntityMatchCandidate
): EntityMatchDecision | null {
  const candidateTokens = tokenizeName(candidate.name)
  const existingTokens = tokenizeName(existing.name)
  if (candidateTokens.length < 2 || existingTokens.length < 2) {
    return scoreFallbackMatch(candidate, existing)
  }

  const candidateFirst = candidateTokens[0]
  const candidateLast = candidateTokens[candidateTokens.length - 1]
  const existingFirst = existingTokens[0]
  const existingLast = existingTokens[existingTokens.length - 1]
  const candidateGiven = compactToken(candidateTokens.slice(0, -1).join(' '))
  const existingGiven = compactToken(existingTokens.slice(0, -1).join(' '))

  const lastDistance = normalizedEditDistance(candidateLast, existingLast)
  if (lastDistance > 0.2) {
    return null
  }

  const firstDistance = normalizedEditDistance(candidateFirst, existingFirst)
  const compactFirstDistance = normalizedEditDistance(compactToken(candidateFirst), compactToken(existingFirst))
  const givenDistance = normalizedEditDistance(candidateGiven, existingGiven)

  if (firstDistance <= 0.25 || compactFirstDistance <= 0.12 || givenDistance <= 0.12) {
    const score = Math.max(0.88, 0.97 - ((Math.min(firstDistance, givenDistance) + compactFirstDistance + lastDistance) / 3))
    return {
      entityId: existing.id,
      score,
      strategy: 'deterministic_strong',
      reason: 'same last name with minor given-name spelling drift',
    }
  }

  return null
}

function scoreOrganizationMatch(
  candidate: EntityMatchCandidate,
  existing: EntityMatchCandidate
): EntityMatchDecision | null {
  const candidateBase = organizationBaseKey(candidate.name)
  const existingBase = organizationBaseKey(existing.name)
  if (!candidateBase || !existingBase) return null

  if (candidateBase === existingBase) {
    return {
      entityId: existing.id,
      score: 0.93,
      strategy: 'deterministic_strong',
      reason: 'organization base-name match',
    }
  }

  const distance = normalizedEditDistance(candidateBase, existingBase)
  if (distance <= 0.14) {
    return {
      entityId: existing.id,
      score: 0.84,
      strategy: 'deterministic_ambiguous',
      reason: 'near-identical organization base name',
    }
  }

  return null
}

function scoreFallbackMatch(
  candidate: EntityMatchCandidate,
  existing: EntityMatchCandidate
): EntityMatchDecision | null {
  const candidateNormalized = normalizeEntityName(candidate.name)
  const existingNormalized = normalizeEntityName(existing.name)
  if (!candidateNormalized || !existingNormalized) return null

  if (
    candidateNormalized.includes(existingNormalized)
    || existingNormalized.includes(candidateNormalized)
  ) {
    return {
      entityId: existing.id,
      score: 0.76,
      strategy: 'deterministic_ambiguous',
      reason: 'substring alias overlap',
    }
  }

  return null
}

function compareScoredMatches(left: ScoredEntityCandidate | null, right: ScoredEntityCandidate | null): number {
  if (!left) return 1
  if (!right) return -1
  if (right.score !== left.score) return right.score - left.score
  return right.candidate.mentionCount - left.candidate.mentionCount
}

function tokenizeName(value: string): string[] {
  return normalizeEntityName(value).split(' ').filter(Boolean)
}

function compactToken(value: string): string {
  return normalizeEntityName(value).replace(/\s+/g, '')
}

function organizationBaseKey(value: string): string {
  const tokens = tokenizeName(value).filter(token => !ORGANIZATION_SUFFIXES.has(token))
  return tokens.join(' ')
}

function isOrganizationLike(entityType: string): boolean {
  return ['vendor', 'customer', 'team', 'tool', 'project'].includes(entityType)
}

function normalizedEditDistance(left: string, right: string): number {
  if (!left && !right) return 0
  if (!left || !right) return 1
  const distance = levenshtein(left, right)
  return distance / Math.max(left.length, right.length, 1)
}

function levenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: right.length + 1 }, () => new Array<number>(left.length + 1).fill(0))
  for (let i = 0; i <= right.length; i++) matrix[i][0] = i
  for (let j = 0; j <= left.length; j++) matrix[0][j] = j

  for (let i = 1; i <= right.length; i++) {
    for (let j = 1; j <= left.length; j++) {
      const cost = right[i - 1] === left[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
    }
  }

  return matrix[right.length][left.length]
}

function serializeEntityForLLM(entity: EntityMatchCandidate) {
  return {
    id: entity.id,
    entityType: entity.entityType,
    name: entity.name,
    canonicalName: entity.canonicalName,
    email: extractEntityEmail(entity.attributes),
    aliases: entity.aliases ?? [],
    mentionCount: entity.mentionCount,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchResolutionCandidates(input: {
  supabase: any
  orgId: string
  candidate: Omit<EntityMatchCandidate, 'id' | 'mentionCount'>
}): Promise<EntityMatchCandidate[]> {
  const directEntityIds = new Set<string>()
  const searchTerms = buildResolutionSearchTerms(input.candidate.name, input.candidate.entityType)
  const email = extractEntityEmail(input.candidate.attributes)

  if (email) {
    const { data: exactEmail } = await input.supabase
      .from('entities')
      .select('id')
      .eq('org_id', input.orgId)
      .eq('entity_type', input.candidate.entityType)
      .eq('attributes->>email', email)
      .limit(3)

    for (const row of exactEmail ?? []) {
      if (typeof row.id === 'string') directEntityIds.add(row.id)
    }
  }

  const exactVariants = buildResolutionVariants(input.candidate.name, input.candidate.entityType)
  if (exactVariants.length > 0) {
    const { data: aliasRows } = await input.supabase
      .from('entity_aliases')
      .select('entity_id')
      .eq('org_id', input.orgId)
      .eq('entity_type', input.candidate.entityType)
      .in('normalized_alias', exactVariants)
      .limit(10)

    for (const row of aliasRows ?? []) {
      if (typeof row.entity_id === 'string') directEntityIds.add(row.entity_id)
    }
  }

  for (const term of searchTerms) {
    const { data: entityRows } = await input.supabase
      .from('entities')
      .select('id')
      .eq('org_id', input.orgId)
      .eq('entity_type', input.candidate.entityType)
      .ilike('canonical_name', `%${term}%`)
      .limit(10)

    for (const row of entityRows ?? []) {
      if (typeof row.id === 'string') directEntityIds.add(row.id)
    }

    const { data: aliasRows } = await input.supabase
      .from('entity_aliases')
      .select('entity_id')
      .eq('org_id', input.orgId)
      .eq('entity_type', input.candidate.entityType)
      .ilike('normalized_alias', `%${term}%`)
      .limit(10)

    for (const row of aliasRows ?? []) {
      if (typeof row.entity_id === 'string') directEntityIds.add(row.entity_id)
    }
  }

  if (directEntityIds.size === 0) return []

  const entityIds = [...directEntityIds]
  const [{ data: entities }, { data: aliases }] = await Promise.all([
    input.supabase
      .from('entities')
      .select('id, entity_type, name, canonical_name, mention_count, attributes')
      .eq('org_id', input.orgId)
      .in('id', entityIds),
    input.supabase
      .from('entity_aliases')
      .select('entity_id, alias')
      .eq('org_id', input.orgId)
      .in('entity_id', entityIds)
      .limit(100),
  ])

  const aliasesByEntity = new Map<string, string[]>()
  for (const row of aliases ?? []) {
    if (typeof row.entity_id !== 'string' || typeof row.alias !== 'string') continue
    const existing = aliasesByEntity.get(row.entity_id) ?? []
    existing.push(row.alias)
    aliasesByEntity.set(row.entity_id, existing)
  }

  return (entities ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    entityType: String(row.entity_type),
    name: String(row.name),
    canonicalName: String(row.canonical_name),
    mentionCount: Number(row.mention_count ?? 0),
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    aliases: aliasesByEntity.get(String(row.id)) ?? [],
  }))
}

function buildResolutionSearchTerms(name: string, entityType: string): string[] {
  const normalized = normalizeEntityName(name)
  if (!normalized) return []
  const tokens = normalized.split(' ').filter(Boolean)
  const terms = new Set<string>([normalized])

  if (tokens.length > 0) {
    terms.add(tokens[0])
    terms.add(tokens[tokens.length - 1])
  }

  if (entityType === 'person' && tokens.length >= 2) {
    terms.add(tokens.slice(-2).join(' '))
  }

  if (isOrganizationLike(entityType)) {
    const base = organizationBaseKey(name)
    if (base) terms.add(base)
  }

  return [...terms].filter(term => term.length >= 3)
}

function buildStoredAliasVariants(alias: string, entityType: string): string[] {
  return buildExactComparableVariants(alias, entityType)
}

function buildExactComparableVariants(alias: string, entityType: string): string[] {
  const normalized = normalizeEntityName(alias)
  if (!normalized) return []

  const variants = new Set<string>([normalized])
  const tokens = normalized.split(' ').filter(Boolean)

  if (entityType === 'person' && tokens.length >= 2) {
    variants.add(tokens.map(token => token.replace(/\./g, '')).join(' '))
  }

  return [...variants]
}
