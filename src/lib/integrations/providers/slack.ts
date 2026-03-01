import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class SlackAuthService extends BaseAuthService {
  readonly integrationKey = 'slack'

  getDefaultScopes(): string[] {
    return [
      // Read capabilities
      'channels:read',      // List public channels
      'channels:history',   // Read public channel messages
      'groups:read',        // List private channels
      'groups:history',     // Read private channel messages
      'im:read',            // List DM channels
      'im:history',         // Read DM messages
      'mpim:read',          // List group DM channels
      'mpim:history',       // Read group DM messages
      // Write capabilities
      'chat:write',         // Send messages
      'im:write',           // Open DM channels
      // User info
      'users:read',         // Look up users
      'users:read.email',   // Look up by email
    ]
  }

  async getAuthUrl(scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.SLACK_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('SLACK_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(','),
      state,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
    })

    return `https://slack.com/oauth/v2/authorize?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: (process.env.SLACK_CLIENT_ID ?? '').trim(),
        client_secret: (process.env.SLACK_CLIENT_SECRET ?? '').trim(),
        code,
        redirect_uri: redirectUri,
      }),
    })

    const data = await response.json()
    if (!data.ok) {
      throw new Error(`Slack OAuth error: ${data.error}`)
    }

    return {
      access_token: data.access_token,
      token_type: 'bearer',
      scope: data.scope,
      raw: {
        team_id: data.team?.id,
        team_name: data.team?.name,
        bot_user_id: data.bot_user_id,
        authed_user: data.authed_user,
      },
    }
  }

  async refreshToken(): Promise<TokenResult> {
    // Slack bot tokens don't expire, no refresh needed
    throw new Error('Slack tokens do not require refresh')
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const data = await response.json()
      return { healthy: data.ok, error: data.ok ? undefined : data.error }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
