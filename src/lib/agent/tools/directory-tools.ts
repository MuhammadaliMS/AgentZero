import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

/**
 * Google Workspace Directory tools — look up people in the organization.
 *
 * Uses the Google People API `searchDirectoryPeople` endpoint, which requires
 * the `directory.readonly` scope. This is a non-admin scope — any Google
 * Workspace user can search their organization's directory.
 *
 * Falls back to existing Google tokens (google_calendar → gmail) in case
 * they happen to have directory access.
 */
export function createDirectoryTools(orgId: string) {
  const lookupWorkspaceUser = tool(
    'lookup_workspace_user',
    'Search your Google Workspace organization directory for people by name. Returns email, title, department, and photo URL. Use this to find someone\'s email before sending a Slack DM or email.',
    {
      query: z.string().describe('Person name to search for (e.g. "Devanand", "Sarah Chen")'),
    },
    async (args) => {
      // Try google_directory first, then fall back to google_calendar and gmail tokens
      let tokens = await TokenManager.getTokens(orgId, 'google_directory')
      if (!tokens) tokens = await TokenManager.getTokens(orgId, 'google_calendar')
      if (!tokens) tokens = await TokenManager.getTokens(orgId, 'gmail')

      if (!tokens) {
        return buildIntegrationRequiredResult('google_directory', 'Google Workspace Directory')
      }

      try {
        const params = new URLSearchParams({
          query: args.query,
          readMask: 'names,emailAddresses,organizations,photos',
          sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE',
          pageSize: '10',
        })

        const response = await fetch(
          `https://people.googleapis.com/v1/people:searchDirectoryPeople?${params}`,
          { headers: { Authorization: `Bearer ${tokens.access_token}` } }
        )

        if (!response.ok) {
          const errText = await response.text()
          // If 403/401, the token doesn't have directory scope — prompt for dedicated connection
          if (response.status === 401 || response.status === 403) {
            return buildIntegrationRequiredResult('google_directory', 'Google Workspace Directory')
          }
          return { content: [{ type: 'text' as const, text: `Google Directory error (${response.status}): ${errText.slice(0, 200)}` }] }
        }

        const data = await response.json()
        const people = (data.people || []) as Array<{
          names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>
          emailAddresses?: Array<{ value?: string; type?: string }>
          organizations?: Array<{ title?: string; department?: string; name?: string }>
          photos?: Array<{ url?: string }>
        }>

        if (people.length === 0) {
          return { content: [{ type: 'text' as const, text: `No people found in workspace directory matching "${args.query}".` }] }
        }

        const matches = people.map(person => ({
          name: person.names?.[0]?.displayName || 'Unknown',
          given_name: person.names?.[0]?.givenName || undefined,
          family_name: person.names?.[0]?.familyName || undefined,
          email: person.emailAddresses?.[0]?.value || undefined,
          title: person.organizations?.[0]?.title || undefined,
          department: person.organizations?.[0]?.department || undefined,
          organization: person.organizations?.[0]?.name || undefined,
          photo_url: person.photos?.[0]?.url || undefined,
        }))

        return { content: [{ type: 'text' as const, text: JSON.stringify({ matches, total: matches.length }, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Google Directory error: ${(e as Error).message}` }] }
      }
    },
    { annotations: { title: 'Look Up Workspace User', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  return [lookupWorkspaceUser]
}
