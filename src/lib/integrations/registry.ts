import type { BaseAuthService } from './base-auth'

// Google — split by product so each only requests the scopes it needs
import { GmailAuthService } from './providers/gmail'
import { GoogleCalendarAuthService } from './providers/google-calendar'
import { GoogleDirectoryAuthService } from './providers/google-directory'

// Microsoft — split by product for the same reason
import { OutlookAuthService } from './providers/outlook'
import { MicrosoftCalendarAuthService } from './providers/microsoft-calendar'
import { TeamsAuthService } from './providers/teams'

// Slack
import { SlackAuthService } from './providers/slack'

// Security & compliance tools
import { VantaAuthService } from './providers/vanta'
import { CrowdStrikeAuthService } from './providers/crowdstrike'
import { QualysAuthService } from './providers/qualys'

// Productivity
import { JiraAuthService } from './providers/jira'
import { GitHubAuthService } from './providers/github'
import { NotionAuthService } from './providers/notion'
import { ZoomAuthService } from './providers/zoom'

type ProviderConstructor = new () => BaseAuthService

/**
 * Maps integration keys (as stored in the `integrations` DB table) to their
 * OAuth provider class.
 *
 * Each provider's getDefaultScopes() returns ONLY the scopes needed for that
 * specific product — no cross-product scope bundling.
 */
const PROVIDER_MAP: Record<string, ProviderConstructor> = {
  // Google
  // Scopes: gmail.readonly, gmail.send, email, profile
  gmail: GmailAuthService,
  // Scopes: calendar.readonly, email, profile
  google_calendar: GoogleCalendarAuthService,
  // Scopes: directory.readonly, email, profile
  google_directory: GoogleDirectoryAuthService,

  // Microsoft 365
  // Scopes: Mail.Read, Mail.Send, User.Read, offline_access
  outlook: OutlookAuthService,
  // microsoft_365 alias kept for existing DB rows
  microsoft_365: OutlookAuthService,
  // Scopes: Calendars.Read, User.Read, offline_access
  microsoft_calendar: MicrosoftCalendarAuthService,
  // Scopes: Chat.Read, User.Read, offline_access
  teams: TeamsAuthService,

  // Slack
  // Scopes: channels:read, chat:write, im:write, im:history, users:read, users:read.email
  slack: SlackAuthService,

  // Security & Compliance
  vanta: VantaAuthService,
  crowdstrike: CrowdStrikeAuthService,
  qualys: QualysAuthService,

  // Productivity
  jira: JiraAuthService,
  github: GitHubAuthService,
  notion: NotionAuthService,
  zoom: ZoomAuthService,
}

// Cache instantiated providers — safe because they hold no mutable state
const providerInstances = new Map<string, BaseAuthService>()

export function getProvider(key: string): BaseAuthService {
  const cached = providerInstances.get(key)
  if (cached) return cached

  const Constructor = PROVIDER_MAP[key]
  if (!Constructor) {
    throw new Error(`No provider found for integration key: "${key}"`)
  }

  const instance = new Constructor()
  providerInstances.set(key, instance)
  return instance
}

export function hasProvider(key: string): boolean {
  return key in PROVIDER_MAP
}

export function getAllProviderKeys(): string[] {
  return Object.keys(PROVIDER_MAP)
}

/**
 * Returns the exact OAuth scopes a given integration key will request.
 * Useful for displaying to users before they click Connect.
 */
export function getScopesForKey(key: string): string[] {
  const provider = getProvider(key)
  return provider.getDefaultScopes()
}
