import { ApiKeyAuthService } from '../base-auth'
import type { TokenResult, TokenData } from '@/types/integrations'

export class QualysAuthService extends ApiKeyAuthService {
  readonly integrationKey = 'qualys'

  async validateCredentials(credentials: Record<string, string>): Promise<TokenResult> {
    const { api_url, username, password } = credentials

    if (!api_url || !username || !password) {
      throw new Error('API URL, username, and password are required')
    }

    // Test the credentials
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')
    const response = await fetch(`${api_url}/api/2.0/fo/scan/?action=list&truncation_limit=1`, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'X-Requested-With': 'Zerowing',
      },
    })

    if (!response.ok) {
      throw new Error('Invalid Qualys credentials')
    }

    return {
      access_token: basicAuth,
      token_type: 'basic',
      raw: { api_url, username },
    }
  }

  async testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }> {
    try {
      const apiUrl = process.env.QUALYS_API_URL || 'https://qualysapi.qualys.com'
      const response = await fetch(`${apiUrl}/api/2.0/fo/scan/?action=list&truncation_limit=1`, {
        headers: {
          Authorization: `Basic ${tokens.access_token}`,
          'X-Requested-With': 'Zerowing',
        },
      })
      return { healthy: response.ok, error: response.ok ? undefined : `Status ${response.status}` }
    } catch (e) {
      return { healthy: false, error: (e as Error).message }
    }
  }
}
