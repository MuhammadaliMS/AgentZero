import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

/**
 * Microsoft Teams OAuth provider.
 *
 * Scopes needed (Microsoft Graph):
 *   - Chat.Read              (read 1:1 and group chats)
 *   - ChannelMessage.Read.All (read channel messages — requires admin consent)
 *   - User.Read              (identify the account)
 *   - offline_access         (refresh token)
 *
 * In Azure AD app registration → API permissions, add:
 *   Microsoft Graph → Delegated → Chat.Read, User.Read
 *   Microsoft Graph → Delegated → ChannelMessage.Read.All (may need admin consent)
 */
export class TeamsAuthService extends BaseAuthService {
  readonly integrationKey = 'teams'

  getDefaultScopes(): string[] {
    return ['Chat.Read', 'User.Read', 'offline_access']
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.MICROSOFT_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('MICROSOFT_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      response_mode: 'query',
    })

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.MICROSOFT_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.MICROSOFT_CLIENT_SECRET ?? '').trim(),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Microsoft OAuth error: ${data.error_description || data.error}`)
    }

    const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    const userInfo = await userResponse.json()

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
      raw: { email: userInfo.mail || userInfo.userPrincipalName, name: userInfo.displayName },
    }
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.MICROSOFT_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.MICROSOFT_CLIENT_SECRET ?? '').trim(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Microsoft refresh error: ${data.error_description || data.error}`)
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
      const response = await fetch('https://graph.microsoft.com/v1.0/me/chats', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return {
        healthy: response.ok,
        error: response.ok ? undefined : `Status ${response.status}`,
      }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
