import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class ZoomAuthService extends BaseAuthService {
  readonly integrationKey = 'zoom'

  getDefaultScopes(): string[] {
    return ['meeting:read', 'recording:read', 'user:read']
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.ZOOM_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('ZOOM_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
      response_type: 'code',
      state,
    })

    return `https://zoom.us/oauth/authorize?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const credentials = Buffer.from(
      `${(process.env.ZOOM_CLIENT_ID ?? '').trim()}:${(process.env.ZOOM_CLIENT_SECRET ?? '').trim()}`
    ).toString('base64')

    const response = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Zoom OAuth error: ${data.reason || data.error}`)
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
    }
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    const credentials = Buffer.from(
      `${(process.env.ZOOM_CLIENT_ID ?? '').trim()}:${(process.env.ZOOM_CLIENT_SECRET ?? '').trim()}`
    ).toString('base64')

    const response = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Zoom refresh error: ${data.reason || data.error}`)
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
    }
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.zoom.us/v2/users/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
