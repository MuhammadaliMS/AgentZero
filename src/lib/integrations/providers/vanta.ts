import { ApiKeyAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class VantaAuthService extends ApiKeyAuthService {
  readonly integrationKey = 'vanta'

  async validateCredentials(credentials: Record<string, string>): Promise<TokenResult> {
    const { client_id, client_secret } = credentials

    if (!client_id || !client_secret) {
      throw new Error('Client ID and Client Secret are required')
    }

    // Vanta uses client_credentials grant
    const response = await fetch('https://api.vanta.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id,
        client_secret,
        scope: 'vanta-api.all:read',
      }),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(`Vanta auth error: ${data.error || 'Failed to authenticate'}`)
    }

    return {
      access_token: data.access_token,
      expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
      token_type: data.token_type || 'bearer',
      raw: { client_id, client_secret },
    }
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.vanta.com/v1/integrations', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
