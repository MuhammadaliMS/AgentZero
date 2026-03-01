import type { TokenResult, TokenData } from '@/types/integrations'

export abstract class BaseAuthService {
  abstract readonly integrationKey: string

  /**
   * Generate the OAuth authorization URL for the user to grant access.
   * Not applicable for API key integrations.
   */
  abstract getAuthUrl(scopes: string[], state: string): Promise<string>

  /**
   * Exchange an OAuth authorization code for tokens.
   * For API key integrations, this validates and exchanges credentials.
   */
  abstract handleCallback(code: string, redirectUri: string): Promise<TokenResult>

  /**
   * Refresh an expired access token using the refresh token.
   */
  abstract refreshToken(refreshToken: string): Promise<TokenResult>

  /**
   * Test that the stored credentials are still valid.
   */
  abstract testConnection(tokens: TokenData): Promise<{ healthy: boolean; error?: string }>

  /**
   * Get the default scopes for this integration.
   */
  getDefaultScopes(): string[] {
    return []
  }
}

export abstract class ApiKeyAuthService extends BaseAuthService {
  async getAuthUrl(): Promise<string> {
    throw new Error('API key integrations do not use OAuth')
  }

  async refreshToken(): Promise<TokenResult> {
    throw new Error('API key integrations do not use refresh tokens')
  }

  /**
   * Validate and exchange API credentials (client_id/client_secret or API key).
   * Returns a TokenResult with the access token.
   */
  abstract validateCredentials(credentials: Record<string, string>): Promise<TokenResult>

  async handleCallback(code: string): Promise<TokenResult> {
    // For API key integrations, code is actually the JSON-encoded credentials
    const credentials = JSON.parse(code)
    return this.validateCredentials(credentials)
  }
}
