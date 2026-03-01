import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createEmailTools(orgId: string) {
  const readRecentEmails = tool(
    'read_recent_emails',
    'Read recent emails from the connected email provider (Gmail or Outlook). Returns subject, sender, date, and snippet.',
    {
      max_results: z.number().optional().default(20),
      query: z.string().optional().describe('Search query to filter emails'),
    },
    async (args) => {
      // Try Gmail first
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await readGmailEmails(tokens.access_token, args.max_results, args.query)
      }

      // Try Outlook
      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await readOutlookEmails(tokens.access_token, args.max_results, args.query)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Read Recent Emails', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const searchEmails = tool(
    'search_emails',
    'Search emails with a specific query. More targeted than read_recent_emails — use this when looking for specific content.',
    {
      query: z.string().describe('Search query (e.g., "from:ceo board prep", "subject:audit", "vendor risk")'),
      max_results: z.number().optional().default(10),
    },
    async (args) => {
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await readGmailEmails(tokens.access_token, args.max_results, args.query)
      }

      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await readOutlookEmails(tokens.access_token, args.max_results, args.query)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Search Emails', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const draftEmail = tool(
    'draft_email',
    'Draft an email reply or new email. Returns the draft for user review - does NOT send automatically.',
    {
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      in_reply_to: z.string().optional(),
    },
    async (args) => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'draft_ready',
            to: args.to,
            subject: args.subject,
            body: args.body,
            in_reply_to: args.in_reply_to,
            note: 'This draft needs user approval before sending.',
          }, null, 2),
        }],
      }
    },
    { annotations: { title: 'Draft Email', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  )

  return [readRecentEmails, searchEmails, draftEmail]
}

async function readGmailEmails(accessToken: string, maxResults: number, query?: string) {
  try {
    const params = new URLSearchParams({
      maxResults: maxResults.toString(),
      ...(query && { q: query }),
    })

    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    if (!listResponse.ok) {
      // Auth failures mean tokens are expired/revoked — trigger integration card
      if (listResponse.status === 401 || listResponse.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      return { content: [{ type: 'text' as const, text: `Gmail API error: ${listResponse.status}` }] }
    }

    const listData = await listResponse.json()
    const messageIds = listData.messages?.slice(0, maxResults) || []

    const emails = await Promise.all(
      messageIds.map(async (msg: { id: string }) => {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const msgData = await msgResponse.json()

        const headers = msgData.payload?.headers || []
        const getHeader = (name: string) => headers.find((h: { name: string; value: string }) => h.name === name)?.value

        return {
          id: msg.id,
          subject: getHeader('Subject') || '(no subject)',
          from: getHeader('From') || 'unknown',
          date: getHeader('Date') || '',
          snippet: msgData.snippet || '',
        }
      })
    )

    return { content: [{ type: 'text' as const, text: JSON.stringify(emails, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading Gmail: ${(e as Error).message}` }] }
  }
}

async function readOutlookEmails(accessToken: string, maxResults: number, query?: string) {
  try {
    let url = `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}&$select=subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`
    if (query) {
      url += `&$search="${query}"`
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      // Auth failures mean tokens are expired/revoked — trigger integration card
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      return { content: [{ type: 'text' as const, text: `Outlook API error: ${response.status}` }] }
    }

    const data = await response.json()
    const emails = (data.value || []).map((msg: Record<string, unknown>) => ({
      id: msg.id,
      subject: msg.subject || '(no subject)',
      from: (msg.from as { emailAddress?: { address?: string } })?.emailAddress?.address || 'unknown',
      date: msg.receivedDateTime || '',
      snippet: msg.bodyPreview || '',
    }))

    return { content: [{ type: 'text' as const, text: JSON.stringify(emails, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading Outlook: ${(e as Error).message}` }] }
  }
}
