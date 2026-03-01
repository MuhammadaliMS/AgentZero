import { createAdminClient } from '@/lib/supabase/admin'
import { encryptTokenData, decryptTokenData } from '@/lib/utils/crypto'
import type { TokenData, TokenResult } from '@/types/integrations'
import type { Json, Database } from '@/types/database'
import { getProvider } from './registry'

type OrgIntegrationRow = Database['public']['Tables']['organization_integrations']['Row']

export class TokenManager {
  /**
   * Store encrypted tokens for an organization's integration.
   */
  static async storeTokens(
    orgId: string,
    integrationId: string,
    tokens: TokenResult,
    grantedScopes: string[],
    connectedBy: string,
    userMetadata?: Record<string, unknown>
  ): Promise<void> {
    const encrypted = encryptTokenData({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      token_type: tokens.token_type,
      ...(tokens.user_access_token ? { user_access_token: tokens.user_access_token } : {}),
    })

    const supabase = createAdminClient()

    await supabase.from('organization_integrations').upsert(
      {
        org_id: orgId,
        integration_id: integrationId,
        token_data: { encrypted } as unknown as Json,
        token_expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
        granted_scopes: grantedScopes,
        is_active: true,
        health_status: 'healthy',
        connected_by: connectedBy,
        user_metadata: (userMetadata ?? {}) as unknown as Json,
        last_health_check: new Date().toISOString(),
        disconnected_at: null,
      },
      { onConflict: 'org_id,integration_id' }
    )
  }

  /**
   * Retrieve and decrypt tokens for an organization's integration.
   * Automatically refreshes if the token is expired.
   */
  static async getTokens(
    orgId: string,
    integrationKey: string
  ): Promise<TokenData | null> {
    console.log(`[TokenManager] getTokens called: orgId=${orgId}, key=${integrationKey}`)
    const supabase = createAdminClient()

    const { data, error: fetchError } = await supabase
      .from('organization_integrations')
      .select('*, integrations!inner(key)')
      .eq('org_id', orgId)
      .eq('integrations.key', integrationKey)
      .eq('is_active', true)
      .single()

    if (fetchError) {
      console.error(`[TokenManager] Supabase query error for ${integrationKey}:`, fetchError.message)
    }

    const orgIntegration = data as (OrgIntegrationRow & { integrations: { key: string } }) | null
    if (!orgIntegration?.token_data) {
      console.log(`[TokenManager] No token_data found for ${integrationKey}`)
      return null
    }

    const tokenData = orgIntegration.token_data as unknown as { encrypted: string }
    let tokens: TokenData
    try {
      tokens = decryptTokenData<TokenData>(tokenData.encrypted)
      console.log(`[TokenManager] Decrypted tokens for ${integrationKey}: expires_at=${tokens.expires_at}, has_refresh=${!!tokens.refresh_token}`)
    } catch (decryptErr) {
      console.error(`[TokenManager] Decrypt failed for ${integrationKey}:`, decryptErr)
      return null
    }

    // Check if token is expired
    if (tokens.expires_at) {
      const expiresAt = new Date(tokens.expires_at)
      const now = new Date()
      const diff = expiresAt.getTime() - now.getTime()
      console.log(`[TokenManager] Token expiry check for ${integrationKey}: expiresAt=${expiresAt.toISOString()}, now=${now.toISOString()}, diff=${diff}ms`)
      // Refresh if expires within 5 minutes
      if (diff < 5 * 60 * 1000) {
        console.log(`[TokenManager] Token expired or expiring soon for ${integrationKey}, attempting refresh...`)
        if (tokens.refresh_token) {
          try {
            const provider = getProvider(integrationKey)
            console.log(`[TokenManager] Got provider for ${integrationKey}, calling refreshToken...`)
            const refreshed = await provider.refreshToken(tokens.refresh_token)
            console.log(`[TokenManager] Token refreshed for ${integrationKey}: new expires_at=${refreshed.expires_at}`)

            // Store refreshed tokens
            await TokenManager.storeTokens(
              orgId,
              orgIntegration.integration_id,
              refreshed,
              orgIntegration.granted_scopes ?? [],
              orgIntegration.connected_by ?? '',
              orgIntegration.user_metadata as Record<string, unknown> | undefined
            )

            return {
              access_token: refreshed.access_token,
              refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
              expires_at: refreshed.expires_at,
              token_type: refreshed.token_type,
            }
          } catch (refreshErr) {
            console.error(`[TokenManager] Token refresh FAILED for ${integrationKey}:`, refreshErr)
            // Mark as unhealthy if refresh fails
            await supabase
              .from('organization_integrations')
              .update({
                health_status: 'error',
                failure_error: `Token refresh failed: ${(refreshErr as Error).message}`,
              })
              .eq('id', orgIntegration.id)
            return null
          }
        }
        console.log(`[TokenManager] No refresh_token for ${integrationKey}, returning null`)
        return null
      }
    }

    console.log(`[TokenManager] Returning valid tokens for ${integrationKey}`)
    return tokens
  }

  /**
   * Disconnect an integration for an organization.
   */
  static async disconnect(orgId: string, integrationKey: string): Promise<void> {
    const supabase = createAdminClient()

    // Look up integration ID first
    const { data: integration } = await supabase
      .from('integrations')
      .select('id')
      .eq('key', integrationKey)
      .single()

    if (!integration) return

    await supabase
      .from('organization_integrations')
      .update({
        is_active: false,
        token_data: null,
        token_expires_at: null,
        disconnected_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('integration_id', (integration as { id: string }).id)
  }
}
