import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class JiraAuthService extends BaseAuthService {
  readonly integrationKey = 'jira'

  getDefaultScopes(): string[] {
    return ['read:jira-work', 'read:jira-user']
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.JIRA_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('JIRA_CLIENT_ID is not set')

    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: clientId,
      scope: scopes.join(' '),
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
      state,
      response_type: 'code',
      prompt: 'consent',
    })

    return `https://auth.atlassian.com/authorize?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: (process.env.JIRA_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.JIRA_CLIENT_SECRET ?? '').trim(),
        code,
        redirect_uri: redirectUri,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Jira OAuth error: ${data.error_description || data.error}`)
    }

    // Get accessible resources (cloud IDs)
    const resourcesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    const resources = await resourcesResponse.json()

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      raw: { cloud_id: resources[0]?.id, site_name: resources[0]?.name },
    }
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: (process.env.JIRA_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.JIRA_CLIENT_SECRET ?? '').trim(),
        refresh_token: refreshToken,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Jira refresh error: ${data.error_description || data.error}`)
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
      const response = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
