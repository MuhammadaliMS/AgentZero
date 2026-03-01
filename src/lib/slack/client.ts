import { WebClient } from '@slack/web-api'
import { TokenManager } from '@/lib/integrations/token-manager'

let cachedClients: Map<string, { client: WebClient; expiresAt: number }> = new Map()

/**
 * Get a Slack WebClient for an organization
 */
export async function getSlackClient(orgId: string): Promise<WebClient | null> {
  // Check cache
  const cached = cachedClients.get(orgId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client
  }

  const tokens = await TokenManager.getTokens(orgId, 'slack')
  if (!tokens) return null

  const client = new WebClient(tokens.access_token)

  // Cache for 5 minutes (Slack bot tokens don't expire, but respect refresh patterns)
  cachedClients.set(orgId, {
    client,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })

  return client
}

/**
 * Clear cached client for an org (use after disconnect)
 */
export function clearSlackClientCache(orgId: string) {
  cachedClients.delete(orgId)
}
