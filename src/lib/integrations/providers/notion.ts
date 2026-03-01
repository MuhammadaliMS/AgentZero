import { BaseAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class NotionAuthService extends BaseAuthService {
  readonly integrationKey = 'notion'

  async getAuthUrl(_scopes: string[], state: string): Promise<string> {
    const clientId = (process.env.NOTION_CLIENT_ID ?? '').trim()
    if (!clientId) throw new Error('NOTION_CLIENT_ID is not set')

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()}/api/integrations/callback`,
      response_type: 'code',
      owner: 'user',
      state,
    })

    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`
  }

  async handleCallback(code: string, redirectUri: string): Promise<TokenResult> {
    const credentials = Buffer.from(
      `${(process.env.NOTION_CLIENT_ID ?? '').trim()}:${(process.env.NOTION_CLIENT_SECRET ?? '').trim()}`
    ).toString('base64')

    const response = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    const data = await response.json()
    if (data.error) {
      throw new Error(`Notion OAuth error: ${data.error}`)
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type,
      raw: {
        workspace_id: data.workspace_id,
        workspace_name: data.workspace_name,
        owner: data.owner,
      },
    }
  }

  async refreshToken(): Promise<TokenResult> {
    throw new Error('Notion tokens do not use refresh tokens')
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Notion-Version': '2022-06-28',
        },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
