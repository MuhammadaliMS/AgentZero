const truthyValues = new Set(['1', 'true', 'yes', 'on'])

/**
 * Read a boolean feature flag from env or org settings.
 */
export function isFeatureEnabled(
  key: string,
  orgSettings?: Record<string, unknown> | null
): boolean {
  const envKey = key.toUpperCase()
  const envValue = process.env[envKey]
  if (envValue) {
    return truthyValues.has(envValue.toLowerCase())
  }

  const features = orgSettings?.features
  if (features && typeof features === 'object') {
    const value = (features as Record<string, unknown>)[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return truthyValues.has(value.toLowerCase())
  }

  const directValue = orgSettings?.[key]
  if (typeof directValue === 'boolean') return directValue
  if (typeof directValue === 'string') return truthyValues.has(directValue.toLowerCase())

  return false
}
