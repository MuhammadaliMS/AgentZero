export interface TokenResult {
  access_token: string
  refresh_token?: string
  expires_at?: string
  token_type?: string
  scope?: string
  user_access_token?: string  // User-level token (e.g., Slack xoxp- for reading as the user)
  raw?: Record<string, unknown>
}

export interface TokenData {
  access_token: string
  refresh_token?: string
  expires_at?: string
  token_type?: string
  user_access_token?: string  // User-level token for services like Slack
}

export interface IntegrationManifest {
  oauth_authorize_url?: string
  oauth_token_url?: string
  default_scopes?: string[]
  client_id_env_key?: string
  client_secret_env_key?: string
}

export interface IntegrationInstruction {
  step: number
  title: string
  description: string
}

export interface IntegrationWithStatus {
  id: string
  key: string
  vendor: string
  name: string
  description: string | null
  logo_url: string | null
  auth_type: 'oauth2' | 'api_key'
  category: string
  status: 'active' | 'upcoming'
  manifest: IntegrationManifest | null
  instructions: IntegrationInstruction[] | null
  parent_integration_id: string | null
  display_order: number
  connected: boolean
  health_status?: string
  org_integration_id?: string
  user_metadata?: Record<string, unknown> | null
}

export interface OAuthState {
  key: string
  org_id: string
  user_id: string
  redirect_to: string
  timestamp: number
}

export type IntegrationCategory =
  | 'email'
  | 'messenger'
  | 'calendar'
  | 'risk_and_compliance'
  | 'endpoint_detection'
  | 'vulnerability_management'
  | 'developer_tools'
  | 'content_management'
  | 'meeting_intelligence'
