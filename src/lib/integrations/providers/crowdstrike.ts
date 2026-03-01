import { ApiKeyAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class CrowdStrikeAuthService extends ApiKeyAuthService {
  readonly integrationKey = 'crowdstrike'

  async validateCredentials(credentials: Record<string, string>): Promise<TokenResult> {
    const { client_id, client_secret, base_url } = credentials
    const apiBase = base_url || 'https://api.crowdstrike.com'

    if (!client_id || !client_secret) {
      throw new Error('Client ID and Client Secret are required')
    }

    const response = await fetch(`${apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id, client_secret }),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(`CrowdStrike auth error: ${data.errors?.[0]?.message || 'Failed to authenticate'}`)
    }

    return {
      access_token: data.access_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      raw: { client_id, client_secret, base_url: apiBase },
    }
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.crowdstrike.com/sensors/queries/installers/v1?limit=1', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
