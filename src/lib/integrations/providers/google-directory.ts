import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

/**
 * Google Workspace Directory — People API
 *
 * OAuth scopes needed:
 *   - https://www.googleapis.com/auth/directory.readonly  (search workspace directory)
 *   - email                                                (identify the account)
 *   - profile                                              (display name)
 *
 * In Google Cloud Console:
 *   1. Enable the "People API" in APIs & Services → Library
 *   2. Add the directory.readonly scope in OAuth consent screen → Scopes
 *
 * NOTE: `directory.readonly` via the People API is a NON-ADMIN scope.
 * Any Google Workspace user can search their organization's directory.
 * This is different from the Admin SDK's `admin.directory.user.readonly`
 * which requires Google Workspace admin privileges.
 */
export class GoogleDirectoryAuthService extends BaseAuthService {
  readonly integrationKey = 'google_directory'

  getDefaultScopes(): string[] {
    return [
      'https://www.googleapis.com/auth/directory.readonly',
      'email',
      'profile',
    ]
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    })

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.GOOGLE_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.GOOGLE_CLIENT_SECRET ?? '').trim(),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Google OAuth error: ${data.error_description || data.error}`)
    }

    // Fetch user info to store connected account email
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    const userInfo = await userResponse.json()

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
      raw: { email: userInfo.email, name: userInfo.name },
    }
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.GOOGLE_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.GOOGLE_CLIENT_SECRET ?? '').trim(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Google refresh error: ${data.error_description || data.error}`)
    }

    return {
      access_token: data.access_token,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
    }
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      // Verify directory access by fetching the authenticated user's profile
      const response = await fetch(
        'https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      )
      return {
        healthy: response.ok,
        error: response.ok ? undefined : `Status ${response.status}`,
      }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
