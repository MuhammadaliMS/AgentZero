import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class GitHubAuthService extends BaseAuthService {
  readonly integrationKey = 'github'

  getDefaultScopes(): string[] {
    return ['repo:status', 'read:org']
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.GITHUB_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('GITHUB_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(' '),
      state,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
    })

    return `https://github.com/login/oauth/authorize?${params.toString()}`
  }

  async handleCallback(code: string): Promise<TokenResult> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: (process.env.GITHUB_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.GITHUB_CLIENT_SECRET ?? '').trim(),
        code,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`)
    }

    // Get user info
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    const user = await userResponse.json()

    return {
      access_token: data.access_token,
      token_type: data.token_type,
      scope: data.scope,
      raw: { login: user.login, name: user.name },
    }
  }

  async refreshToken(): Promise<TokenResult> {
    throw new Error('GitHub tokens do not use refresh tokens')
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
