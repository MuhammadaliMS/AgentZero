import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TokenManager } from '@/lib/integrations/token-manager'
import { buildIntegrationRequiredResult } from '../tool-metadata'

export function createEmailTools(orgId: string) {
  const readRecentEmails = tool(
    'read_recent_emails',
    'Read recent emails from the connected email provider (Gmail or Outlook). Returns subject, sender, date, snippet, and labels.',
    {
      max_results: z.number().optional().default(20),
      query: z.string().optional().describe('Search query to filter emails'),
    },
    async (args) => {
      // Try Gmail first
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await listGmailEmails(tokens.access_token, args.max_results, args.query)
      }

      // Try Outlook
      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await listOutlookEmails(tokens.access_token, args.max_results, args.query)
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
        return await listGmailEmails(tokens.access_token, args.max_results, args.query)
      }

      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await listOutlookEmails(tokens.access_token, args.max_results, args.query)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Search Emails', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const readEmail = tool(
    'read_email',
    'Read the full body of a specific email by its ID. Use this after read_recent_emails or search_emails to get the complete content of an email.',
    {
      email_id: z.string().describe('The email ID from read_recent_emails or search_emails'),
    },
    async (args) => {
      // Try Gmail first
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await readGmailEmail(tokens.access_token, args.email_id)
      }

      // Try Outlook
      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await readOutlookEmail(tokens.access_token, args.email_id)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Read Email', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
  )

  const draftEmail = tool(
    'draft_email',
    'Create a draft email in the user\'s mailbox (Gmail or Outlook). The draft appears in their Drafts folder for review before sending. Does NOT send automatically.',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipients, comma-separated'),
      in_reply_to: z.string().optional().describe('Message ID to reply to (creates a reply draft)'),
    },
    async (args) => {
      // Try Gmail
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await createGmailDraft(tokens.access_token, args)
      }

      // Try Outlook
      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await createOutlookDraft(tokens.access_token, args)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Draft Email', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  const sendEmail = tool(
    'send_email',
    'Send an email directly via Gmail or Outlook. Use this only after getting explicit user approval. For drafts that the user wants to review first, use draft_email instead.',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipients, comma-separated'),
      in_reply_to: z.string().optional().describe('Message ID to reply to'),
    },
    async (args) => {
      // Try Gmail
      let tokens = await TokenManager.getTokens(orgId, 'gmail')
      if (tokens) {
        return await sendGmailEmail(tokens.access_token, args)
      }

      // Try Outlook
      tokens = await TokenManager.getTokens(orgId, 'microsoft_365')
      if (tokens) {
        return await sendOutlookEmail(tokens.access_token, args)
      }

      return buildIntegrationRequiredResult('gmail', 'Gmail')
    },
    { annotations: { title: 'Send Email', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
  )

  return [readRecentEmails, searchEmails, readEmail, draftEmail, sendEmail]
}

// ─── Gmail Helpers ────────────────────────────────────────────────────────

/** Map Gmail label IDs to human-readable names */
const GMAIL_LABEL_MAP: Record<string, string> = {
  IMPORTANT: 'Important',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  CATEGORY_PERSONAL: 'Personal',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
}

function mapGmailLabels(labelIds: string[] = []): string[] {
  return labelIds
    .map(id => GMAIL_LABEL_MAP[id])
    .filter(Boolean) as string[]
}

/** List Gmail emails with metadata + labels */
async function listGmailEmails(accessToken: string, maxResults: number, query?: string) {
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
      if (listResponse.status === 401 || listResponse.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      return { content: [{ type: 'text' as const, text: `Gmail API error: ${listResponse.status}` }] }
    }

    const listData = await listResponse.json()
    const messageIds = listData.messages?.slice(0, maxResults) || []

    // Fetch each message metadata in parallel
    const emails = await Promise.all(
      messageIds.map(async (msg: { id: string }) => {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const msgData = await msgResponse.json()

        const headers = msgData.payload?.headers || []
        const getHeader = (name: string) => headers.find((h: { name: string; value: string }) => h.name === name)?.value

        return {
          id: msg.id,
          subject: getHeader('Subject') || '(no subject)',
          from: getHeader('From') || 'unknown',
          to: getHeader('To') || '',
          date: getHeader('Date') || '',
          snippet: msgData.snippet || '',
          labels: mapGmailLabels(msgData.labelIds),
        }
      })
    )

    return { content: [{ type: 'text' as const, text: JSON.stringify(emails, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading Gmail: ${(e as Error).message}` }] }
  }
}

/** Extract text body from Gmail message MIME structure */
function extractGmailBody(payload: Record<string, unknown>): string {
  // Simple message — body is directly on the payload
  const mimeType = payload.mimeType as string || ''
  const bodyData = (payload.body as { data?: string })?.data

  if (mimeType === 'text/plain' && bodyData) {
    return Buffer.from(bodyData, 'base64url').toString('utf-8')
  }

  // Multipart — search parts recursively
  const parts = (payload.parts as Array<Record<string, unknown>>) || []

  // First pass: look for text/plain
  for (const part of parts) {
    const partMime = part.mimeType as string || ''
    const partBody = (part.body as { data?: string })?.data

    if (partMime === 'text/plain' && partBody) {
      return Buffer.from(partBody, 'base64url').toString('utf-8')
    }

    // Recurse into nested multipart
    if (partMime.startsWith('multipart/') && part.parts) {
      const nested = extractGmailBody(part)
      if (nested) return nested
    }
  }

  // Second pass: fall back to text/html (strip tags)
  for (const part of parts) {
    const partMime = part.mimeType as string || ''
    const partBody = (part.body as { data?: string })?.data

    if (partMime === 'text/html' && partBody) {
      const html = Buffer.from(partBody, 'base64url').toString('utf-8')
      return stripHtml(html)
    }
  }

  return ''
}

/** Strip HTML tags and decode common entities */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read a single Gmail email with full body */
async function readGmailEmail(accessToken: string, emailId: string) {
  try {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      return { content: [{ type: 'text' as const, text: `Gmail API error: ${response.status}` }] }
    }

    const msgData = await response.json()
    const headers = msgData.payload?.headers || []
    const getHeader = (name: string) => headers.find((h: { name: string; value: string }) => h.name === name)?.value

    const body = extractGmailBody(msgData.payload || {})

    const email = {
      id: emailId,
      subject: getHeader('Subject') || '(no subject)',
      from: getHeader('From') || 'unknown',
      to: getHeader('To') || '',
      cc: getHeader('Cc') || '',
      date: getHeader('Date') || '',
      labels: mapGmailLabels(msgData.labelIds),
      body: body || msgData.snippet || '(no body)',
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(email, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading email: ${(e as Error).message}` }] }
  }
}

// ─── Gmail Draft & Send ──────────────────────────────────────────────────

interface EmailArgs {
  to: string
  subject: string
  body: string
  cc?: string
  in_reply_to?: string
}

/** Build a RFC 2822 MIME message and base64url-encode it for Gmail API */
function buildGmailRawMessage(args: EmailArgs): string {
  const lines: string[] = []
  lines.push(`To: ${args.to}`)
  if (args.cc) lines.push(`Cc: ${args.cc}`)
  lines.push(`Subject: ${args.subject}`)
  if (args.in_reply_to) {
    lines.push(`In-Reply-To: ${args.in_reply_to}`)
    lines.push(`References: ${args.in_reply_to}`)
  }
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('')
  lines.push(args.body)

  const raw = lines.join('\r\n')
  // Gmail API expects base64url (no padding)
  return Buffer.from(raw).toString('base64url')
}

/** Create a draft in Gmail Drafts folder */
async function createGmailDraft(accessToken: string, args: EmailArgs) {
  try {
    const raw = buildGmailRawMessage(args)

    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            raw,
            ...(args.in_reply_to ? { threadId: args.in_reply_to } : {}),
          },
        }),
      }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      const err = await response.text()
      return { content: [{ type: 'text' as const, text: `Gmail draft error (${response.status}): ${err}` }] }
    }

    const data = await response.json()
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'draft_created',
          draft_id: data.id,
          message_id: data.message?.id,
          to: args.to,
          subject: args.subject,
          note: 'Draft saved to Gmail Drafts folder. The user can review and send from their email client.',
        }, null, 2),
      }],
    }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error creating draft: ${(e as Error).message}` }] }
  }
}

/** Send an email via Gmail */
async function sendGmailEmail(accessToken: string, args: EmailArgs) {
  try {
    const raw = buildGmailRawMessage(args)

    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          raw,
          ...(args.in_reply_to ? { threadId: args.in_reply_to } : {}),
        }),
      }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('gmail', 'Gmail')
      }
      const err = await response.text()
      return { content: [{ type: 'text' as const, text: `Gmail send error (${response.status}): ${err}` }] }
    }

    const data = await response.json()
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'sent',
          message_id: data.id,
          to: args.to,
          subject: args.subject,
        }, null, 2),
      }],
    }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error sending email: ${(e as Error).message}` }] }
  }
}

// ─── Outlook Helpers ──────────────────────────────────────────────────────

/** List Outlook emails */
async function listOutlookEmails(accessToken: string, maxResults: number, query?: string) {
  try {
    let url = `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,importance,flag&$orderby=receivedDateTime desc`
    if (query) {
      url += `&$search="${query}"`
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('microsoft_365', 'Microsoft 365')
      }
      return { content: [{ type: 'text' as const, text: `Outlook API error: ${response.status}` }] }
    }

    const data = await response.json()
    const emails = (data.value || []).map((msg: Record<string, unknown>) => {
      const labels: string[] = []
      if (!msg.isRead) labels.push('Unread')
      if (msg.importance === 'high') labels.push('Important')
      if ((msg.flag as { flagStatus?: string })?.flagStatus === 'flagged') labels.push('Flagged')

      return {
        id: msg.id,
        subject: msg.subject || '(no subject)',
        from: (msg.from as { emailAddress?: { address?: string; name?: string } })?.emailAddress?.address || 'unknown',
        to: ((msg.toRecipients as Array<{ emailAddress?: { address?: string } }>) || [])
          .map(r => r.emailAddress?.address)
          .filter(Boolean)
          .join(', '),
        date: msg.receivedDateTime || '',
        snippet: msg.bodyPreview || '',
        labels,
      }
    })

    return { content: [{ type: 'text' as const, text: JSON.stringify(emails, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading Outlook: ${(e as Error).message}` }] }
  }
}

/** Read a single Outlook email with full body */
async function readOutlookEmail(accessToken: string, emailId: string) {
  try {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${emailId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,importance`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('microsoft_365', 'Microsoft 365')
      }
      return { content: [{ type: 'text' as const, text: `Outlook API error: ${response.status}` }] }
    }

    const msg = await response.json()
    const bodyContent = (msg.body as { content?: string; contentType?: string })

    let body = bodyContent?.content || ''
    if (bodyContent?.contentType === 'html' && body) {
      body = stripHtml(body)
    }

    const labels: string[] = []
    if (!msg.isRead) labels.push('Unread')
    if (msg.importance === 'high') labels.push('Important')

    const email = {
      id: emailId,
      subject: msg.subject || '(no subject)',
      from: (msg.from as { emailAddress?: { address?: string } })?.emailAddress?.address || 'unknown',
      to: ((msg.toRecipients as Array<{ emailAddress?: { address?: string } }>) || [])
        .map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address)
        .filter(Boolean)
        .join(', '),
      cc: ((msg.ccRecipients as Array<{ emailAddress?: { address?: string } }>) || [])
        .map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address)
        .filter(Boolean)
        .join(', '),
      date: msg.receivedDateTime || '',
      labels,
      body: body || '(no body)',
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(email, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error reading email: ${(e as Error).message}` }] }
  }
}

// ─── Outlook Draft & Send ────────────────────────────────────────────────

function buildOutlookRecipients(csv: string): Array<{ emailAddress: { address: string } }> {
  return csv.split(',').map(e => e.trim()).filter(Boolean).map(address => ({
    emailAddress: { address },
  }))
}

/** Create a draft in Outlook Drafts folder */
async function createOutlookDraft(accessToken: string, args: EmailArgs) {
  try {
    const draft: Record<string, unknown> = {
      subject: args.subject,
      body: { contentType: 'text', content: args.body },
      toRecipients: buildOutlookRecipients(args.to),
    }
    if (args.cc) {
      draft.ccRecipients = buildOutlookRecipients(args.cc)
    }

    const response = await fetch(
      'https://graph.microsoft.com/v1.0/me/messages',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(draft),
      }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('microsoft_365', 'Microsoft 365')
      }
      const err = await response.text()
      return { content: [{ type: 'text' as const, text: `Outlook draft error (${response.status}): ${err}` }] }
    }

    const data = await response.json()
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'draft_created',
          draft_id: data.id,
          to: args.to,
          subject: args.subject,
          note: 'Draft saved to Outlook Drafts folder. The user can review and send from their email client.',
        }, null, 2),
      }],
    }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error creating draft: ${(e as Error).message}` }] }
  }
}

/** Send an email via Outlook */
async function sendOutlookEmail(accessToken: string, args: EmailArgs) {
  try {
    const message: Record<string, unknown> = {
      subject: args.subject,
      body: { contentType: 'text', content: args.body },
      toRecipients: buildOutlookRecipients(args.to),
    }
    if (args.cc) {
      message.ccRecipients = buildOutlookRecipients(args.cc)
    }

    const response = await fetch(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          saveToSentItems: true,
        }),
      }
    )

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return buildIntegrationRequiredResult('microsoft_365', 'Microsoft 365')
      }
      const err = await response.text()
      return { content: [{ type: 'text' as const, text: `Outlook send error (${response.status}): ${err}` }] }
    }

    // sendMail returns 202 with no body on success
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'sent',
          to: args.to,
          subject: args.subject,
        }, null, 2),
      }],
    }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error sending email: ${(e as Error).message}` }] }
  }
}
