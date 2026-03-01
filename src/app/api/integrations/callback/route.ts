import { NextResponse } from 'next/server'
import { decrypt } from '@/lib/utils/crypto'
import { getProvider } from '@/lib/integrations/registry'
import { TokenManager } from '@/lib/integrations/token-manager'
import { createAdminClient } from '@/lib/supabase/admin'
import type { OAuthState } from '@/types/integrations'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()

  if (error) {
    return NextResponse.redirect(`${appUrl}/onboarding?error=${encodeURIComponent(error)}`)
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(`${appUrl}/onboarding?error=missing_params`)
  }

  try {
    // Decrypt and validate state
    const stateJson = decrypt(stateParam)
    const state: OAuthState = JSON.parse(stateJson)

    // Validate required fields to prevent partial-state attacks
    if (!state.key || !state.org_id || !state.user_id) {
      return NextResponse.redirect(`${appUrl}/onboarding?error=invalid_state`)
    }

    // Validate timestamp (5 minute expiry)
    if (Date.now() - state.timestamp > 5 * 60 * 1000) {
      return NextResponse.redirect(`${appUrl}/onboarding?error=state_expired`)
    }

    // Validate redirect_to is a relative path to prevent open-redirect
    const redirectTo = state.redirect_to && state.redirect_to.startsWith('/') ? state.redirect_to : '/onboarding'

    const provider = getProvider(state.key)
    const redirectUri = `${appUrl}/api/integrations/callback`

    // Exchange code for tokens
    const tokens = await provider.handleCallback(code, redirectUri)

    // Get integration ID from catalog
    const supabase = createAdminClient()
    const { data: integration } = await supabase
      .from('integrations')
      .select('id, manifest')
      .eq('key', state.key)
      .single()

    if (!integration) {
      return NextResponse.redirect(`${appUrl}/onboarding?error=integration_not_found`)
    }

    const manifest = integration.manifest as { default_scopes?: string[] } | null
    const grantedScopes = tokens.scope?.split(/[,\s]+/) ?? manifest?.default_scopes ?? []

    // Build user metadata from token response
    const userMetadata: Record<string, unknown> = {}
    if (tokens.raw) {
      if ('email' in tokens.raw) userMetadata.connected_email = tokens.raw.email
      if ('name' in tokens.raw) userMetadata.account_name = tokens.raw.name
      if ('team_id' in tokens.raw) userMetadata.workspace_id = tokens.raw.team_id
      if ('team_name' in tokens.raw) userMetadata.workspace_name = tokens.raw.team_name
      if ('workspace_id' in tokens.raw) userMetadata.workspace_id = tokens.raw.workspace_id
      if ('workspace_name' in tokens.raw) userMetadata.workspace_name = tokens.raw.workspace_name
      if ('login' in tokens.raw) userMetadata.account_name = tokens.raw.login
      if ('cloud_id' in tokens.raw) userMetadata.cloud_id = tokens.raw.cloud_id
      if ('site_name' in tokens.raw) userMetadata.workspace_name = tokens.raw.site_name
    }

    // Store encrypted tokens
    await TokenManager.storeTokens(
      state.org_id,
      integration.id,
      tokens,
      grantedScopes,
      state.user_id,
      userMetadata
    )

    // Return HTML that sends message to opener and closes popup.
    // Use JSON.stringify for all interpolated values to prevent XSS.
    const safeKey = JSON.stringify(state.key)
    const safeAppUrl = JSON.stringify(appUrl)
    const safeRedirectUrl = JSON.stringify(`${appUrl}${redirectTo}?connected=${encodeURIComponent(state.key)}`)
    return new NextResponse(
      `<!DOCTYPE html>
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'integration_connected', key: ${safeKey} }, ${safeAppUrl});
              window.close();
            } else {
              window.location.href = ${safeRedirectUrl};
            }
          </script>
          <p>Connected! You can close this window.</p>
        </body>
      </html>`,
      {
        headers: { 'Content-Type': 'text/html' },
      }
    )
  } catch (e) {
    console.error('OAuth callback error:', e)
    return NextResponse.redirect(
      `${appUrl}/onboarding?error=${encodeURIComponent((e as Error).message)}`
    )
  }
}
