import { WebClient } from '@slack/web-api'

import { enqueueEvidenceJob, triggerEvidenceJobProcessor } from '@/lib/evidence/jobs'
import { isRelevantEmailMessage, isRelevantSlackConversation } from '@/lib/evidence/sync-filters'
import { isFeatureEnabled } from '@/lib/evidence/flags'
import { extractChiefFocusProfile, type ChiefFocusProfile } from '@/lib/intelligence/focus-profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { TokenManager } from '@/lib/integrations/token-manager'
import { logCronRun, type ExecutionStep } from '@/lib/observability/cron-logger'

const DAYS_BACK = Math.max(Number(process.env.DAILY_EVIDENCE_SYNC_DAYS_BACK) || 1, 1)
const EMAIL_MAX_CANDIDATES = Math.max(Number(process.env.DAILY_EVIDENCE_EMAIL_MAX) || 40, 5)
const EMAIL_MAX_THREADS = Math.max(Number(process.env.DAILY_EVIDENCE_EMAIL_THREADS) || 12, 1)
const SLACK_MAX_CHANNELS = Math.max(Number(process.env.DAILY_EVIDENCE_SLACK_CHANNELS) || 10, 1)
const SLACK_MAX_DMS = Math.max(Number(process.env.DAILY_EVIDENCE_SLACK_DMS) || 10, 1)
const SLACK_CHANNEL_HISTORY_LIMIT = Math.max(Number(process.env.DAILY_EVIDENCE_SLACK_MESSAGES) || 100, 20)

type AdminClient = ReturnType<typeof createAdminClient>

interface SyncMetrics {
  orgs: number
  emailArtifacts: number
  slackArtifacts: number
  skippedEmails: number
  skippedSlack: number
  failed: number
}

/**
 * Run the daily email and Slack sync across all eligible orgs.
 */
export async function runDailyEvidenceSyncBackground(): Promise<void> {
  await logCronRun({ worker: 'daily-evidence-sync' }, async () => {
    const admin = createAdminClient() as any
    const metrics: SyncMetrics = {
      orgs: 0,
      emailArtifacts: 0,
      slackArtifacts: 0,
      skippedEmails: 0,
      skippedSlack: 0,
      failed: 0,
    }
    const steps: ExecutionStep[] = []

    const orgs = await fetchEligibleOrgs(admin)
    metrics.orgs = orgs.length

    if (orgs.length === 0) {
      return { summary: 'No orgs with active Slack or email integrations' }
    }

    for (const org of orgs) {
      const started = Date.now()
      try {
        const result = await syncOrgSources(admin, org.orgId, org.settings ?? {})
        metrics.emailArtifacts += result.emailArtifacts
        metrics.slackArtifacts += result.slackArtifacts
        metrics.skippedEmails += result.skippedEmails
        metrics.skippedSlack += result.skippedSlack
        steps.push({
          ts: new Date().toISOString(),
          type: 'tool_result',
          name: 'sync-org-sources',
          status: 'ok',
          duration_ms: Date.now() - started,
          output: JSON.stringify({ orgId: org.orgId, ...result }).slice(0, 300),
        })
      } catch (error) {
        metrics.failed++
        steps.push({
          ts: new Date().toISOString(),
          type: 'tool_result',
          name: 'sync-org-sources',
          status: 'error',
          duration_ms: Date.now() - started,
          error: `${org.orgId}: ${(error as Error).message}`.slice(0, 300),
        })
      }
    }

    await triggerEvidenceJobProcessor().catch(error => {
      console.error('[daily-evidence-sync] Failed to trigger evidence job processor:', error)
    })

    return {
      summary: `Daily sync complete: ${metrics.emailArtifacts} email artifacts, ${metrics.slackArtifacts} slack artifacts, ${metrics.failed} org failures`,
      metrics: metrics as unknown as Record<string, unknown>,
      steps,
    }
  })
}

async function fetchEligibleOrgs(admin: AdminClient): Promise<Array<{ orgId: string; settings: Record<string, unknown> | null }>> {
  const { data } = await admin
    .from('organization_integrations')
    .select('org_id, integrations!inner(key)')
    .eq('is_active', true)
    .in('integrations.key', ['gmail', 'microsoft_365', 'slack'])

  const orgIds = [...new Set((data ?? []).map((row: Record<string, unknown>) => String(row.org_id ?? '')).filter(Boolean))]
  if (orgIds.length === 0) return []

  const { data: orgRows } = await admin
    .from('organizations')
    .select('id, settings')
    .in('id', orgIds)

  return (orgRows ?? [])
    .map((row: Record<string, unknown>) => ({
      orgId: String(row.id ?? ''),
      settings: (row.settings as Record<string, unknown> | null) ?? null,
    }))
    .filter(row => row.orgId && isFeatureEnabled('evidence_graph_v2', row.settings ?? undefined))
}

async function syncOrgSources(
  admin: AdminClient,
  orgId: string,
  orgSettings: Record<string, unknown>
): Promise<{ emailArtifacts: number; slackArtifacts: number; skippedEmails: number; skippedSlack: number }> {
  let emailArtifacts = 0
  let slackArtifacts = 0
  let skippedEmails = 0
  let skippedSlack = 0
  const focusProfile = extractChiefFocusProfile(orgSettings)

  const [gmailTokens, outlookTokens, slackTokens] = await Promise.all([
    TokenManager.getTokens(orgId, 'gmail'),
    TokenManager.getTokens(orgId, 'microsoft_365'),
    TokenManager.getTokens(orgId, 'slack'),
  ])

  if (gmailTokens || outlookTokens) {
    const emailResult = gmailTokens
      ? await syncGmail(admin, orgId, gmailTokens.access_token, focusProfile)
      : await syncOutlook(admin, orgId, outlookTokens!.access_token, focusProfile)
    emailArtifacts += emailResult.synced
    skippedEmails += emailResult.skipped
  }

  if (slackTokens) {
    const slackResult = await syncSlack(admin, orgId, slackTokens.user_access_token || slackTokens.access_token, focusProfile)
    slackArtifacts += slackResult.synced
    skippedSlack += slackResult.skipped
  }

  return {
    emailArtifacts,
    slackArtifacts,
    skippedEmails,
    skippedSlack,
  }
}

async function syncGmail(
  admin: AdminClient,
  orgId: string,
  accessToken: string,
  focusProfile: ChiefFocusProfile
): Promise<{ synced: number; skipped: number }> {
  const query = [
    `newer_than:${Math.max(DAYS_BACK, 1)}d`,
    'in:inbox',
    '-category:promotions',
    '-category:social',
    '-category:forums',
    '-label:spam',
    '-label:trash',
  ].join(' ')

  const params = new URLSearchParams({
    q: query,
    maxResults: String(EMAIL_MAX_CANDIDATES),
  })

  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Gmail list failed (${response.status})`)
  }

  const data = await response.json()
  const candidates = (data.messages ?? []) as Array<{ id: string; threadId: string }>
  const threadIds = [...new Set(candidates.map(candidate => candidate.threadId).filter(Boolean))].slice(0, EMAIL_MAX_THREADS)

  let synced = 0
  let skipped = 0

  for (const threadId of threadIds) {
    const thread = await fetchGmailThread(accessToken, threadId)
    if (!thread) {
      skipped++
      continue
    }

    const flattened = thread.messages.map(message => ({
      subject: message.subject,
      from: message.from,
      labels: message.labels,
      snippet: message.snippet,
      body: message.body,
    }))

    if (!flattened.some(message => isRelevantEmailMessage(message, focusProfile))) {
      skipped++
      continue
    }

    await enqueueEvidenceJob({
      orgId,
      source: {
        kind: 'email',
        provider: 'gmail',
        thread: {
          id: thread.id,
          subject: thread.subject,
          participants: [...new Set(thread.messages.flatMap(message => [message.fromEmail, ...message.toEmails]).filter(Boolean))],
          sourceUrl: `https://mail.google.com/mail/u/0/#all/${thread.id}`,
        },
        messages: thread.messages.map(message => ({
          id: message.id,
          authorName: message.fromName,
          authorEmail: message.fromEmail,
          text: [
            `Subject: ${message.subject}`,
            `From: ${message.from}`,
            message.body || message.snippet,
          ].join('\n\n').trim(),
          happenedAt: message.date,
        })),
      },
    })

    synced++
  }

  return { synced, skipped }
}

async function syncOutlook(
  admin: AdminClient,
  orgId: string,
  accessToken: string,
  focusProfile: ChiefFocusProfile
): Promise<{ synced: number; skipped: number }> {
  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString()
  const url = [
    'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
    `?$top=${EMAIL_MAX_CANDIDATES}`,
    '&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,categories,inferenceClassification',
    '&$orderby=receivedDateTime desc',
    `&$filter=receivedDateTime ge ${since}`,
  ].join('')

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: 'eventual',
    },
  })

  if (!response.ok) {
    throw new Error(`Outlook list failed (${response.status})`)
  }

  const data = await response.json()
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const message of (data.value ?? []) as Array<Record<string, unknown>>) {
    const conversationId = String(message.conversationId ?? message.id ?? '')
    const existing = grouped.get(conversationId) ?? []
    existing.push(message)
    grouped.set(conversationId, existing)
  }

  let synced = 0
  let skipped = 0

  for (const [conversationId, messages] of [...grouped.entries()].slice(0, EMAIL_MAX_THREADS)) {
    const normalized = messages.map(message => ({
      subject: String(message.subject ?? ''),
      from: String((message.from as { emailAddress?: { address?: string; name?: string } })?.emailAddress?.address ?? ''),
      labels: [
        ...(Array.isArray(message.categories) ? message.categories.map(value => String(value)) : []),
        String(message.inferenceClassification ?? ''),
      ].filter(Boolean),
      snippet: String(message.bodyPreview ?? ''),
      body: extractOutlookBody(message),
    }))

    if (!normalized.some(message => isRelevantEmailMessage(message, focusProfile))) {
      skipped++
      continue
    }

    const sortedMessages = [...messages].sort((left, right) => {
      const leftTs = Date.parse(String(left.receivedDateTime ?? ''))
      const rightTs = Date.parse(String(right.receivedDateTime ?? ''))
      return leftTs - rightTs
    })

    await enqueueEvidenceJob({
      orgId,
      source: {
        kind: 'email',
        provider: 'microsoft_365',
        thread: {
          id: conversationId,
          subject: String(sortedMessages[0]?.subject ?? 'Email thread'),
          participants: [...new Set(sortedMessages.flatMap(message => [
            String((message.from as { emailAddress?: { address?: string } })?.emailAddress?.address ?? ''),
            ...(((message.toRecipients as Array<{ emailAddress?: { address?: string } }>) ?? [])
              .map(recipient => recipient.emailAddress?.address ?? '')),
          ]).filter(Boolean))],
          sourceUrl: null,
        },
        messages: sortedMessages.map(message => ({
          id: String(message.id ?? ''),
          authorName: String((message.from as { emailAddress?: { name?: string } })?.emailAddress?.name ?? ''),
          authorEmail: String((message.from as { emailAddress?: { address?: string } })?.emailAddress?.address ?? ''),
          text: [
            `Subject: ${String(message.subject ?? '')}`,
            `From: ${String((message.from as { emailAddress?: { address?: string } })?.emailAddress?.address ?? '')}`,
            extractOutlookBody(message) || String(message.bodyPreview ?? ''),
          ].join('\n\n').trim(),
          happenedAt: String(message.receivedDateTime ?? ''),
        })),
      },
    })

    synced++
  }

  return { synced, skipped }
}

async function syncSlack(
  admin: AdminClient,
  orgId: string,
  accessToken: string,
  focusProfile: ChiefFocusProfile
): Promise<{ synced: number; skipped: number }> {
  const client = new WebClient(accessToken)
  const authInfo = await client.auth.test()
  const userId = authInfo.user_id
  if (!userId) throw new Error('Slack auth.test missing user_id')

  const afterDate = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const channelCandidates = await fetchActiveSlackChannels(client, userId, afterDate)
  const dmCandidates = await fetchRecentSlackDms(client, afterDate)

  let synced = 0
  let skipped = 0

  for (const candidate of channelCandidates.slice(0, SLACK_MAX_CHANNELS)) {
    const history = await client.conversations.history({
      channel: candidate.channelId,
      oldest: String(Math.floor(Date.now() / 1000) - DAYS_BACK * 24 * 60 * 60),
      limit: SLACK_CHANNEL_HISTORY_LIMIT,
    })

    const messages = await hydrateSlackMessages(client, history.messages ?? [])
    if (!isRelevantSlackConversation({
      channelType: candidate.channelType,
      participantEmails: [],
      messages: messages.map(message => ({ user: message.userName || 'unknown', text: message.text })),
    }, focusProfile)) {
      skipped++
      continue
    }

    await enqueueEvidenceJob({
      orgId,
      source: {
        kind: 'slack',
        conversation: {
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          channelType: candidate.channelType,
          sourceUrl: candidate.sourceUrl,
        },
        messages: messages.map(message => ({
          ts: message.ts,
          userName: message.userName,
          userEmail: message.userEmail,
          text: message.text,
          happenedAt: message.happenedAt,
        })),
      },
    })

    synced++
  }

  for (const candidate of dmCandidates.slice(0, SLACK_MAX_DMS)) {
    const history = await client.conversations.history({
      channel: candidate.channelId,
      oldest: String(Math.floor(Date.now() / 1000) - DAYS_BACK * 24 * 60 * 60),
      limit: SLACK_CHANNEL_HISTORY_LIMIT,
    })
    const messages = await hydrateSlackMessages(client, history.messages ?? [])
    if (messages.length === 0) {
      skipped++
      continue
    }

    if (!isRelevantSlackConversation({
      channelType: candidate.channelType,
      participantEmails: [],
      messages: messages.map(message => ({ user: message.userName || 'unknown', text: message.text })),
    }, focusProfile)) {
      skipped++
      continue
    }

    await enqueueEvidenceJob({
      orgId,
      source: {
        kind: 'slack',
        conversation: {
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          channelType: candidate.channelType,
          sourceUrl: candidate.sourceUrl,
        },
        messages: messages.map(message => ({
          ts: message.ts,
          userName: message.userName,
          userEmail: message.userEmail,
          text: message.text,
          happenedAt: message.happenedAt,
        })),
      },
    })

    synced++
  }

  return { synced, skipped }
}

async function fetchActiveSlackChannels(client: WebClient, userId: string, afterDate: string): Promise<Array<{
  channelId: string
  channelName: string
  channelType: 'public' | 'private'
  sourceUrl: string | null
}>> {
  const candidates = new Map<string, {
    channelId: string
    channelName: string
    channelType: 'public' | 'private'
    sourceUrl: string | null
  }>()

  const queries = [`from:me after:${afterDate}`, `<@${userId}> after:${afterDate}`]
  for (const query of queries) {
    try {
      const result = await client.search.messages({
        query,
        count: 40,
        sort: 'timestamp',
        sort_dir: 'desc',
      })

      for (const match of result.messages?.matches ?? []) {
        const channelId = String((match.channel as { id?: string })?.id ?? '')
        if (!channelId || channelId.startsWith('D')) continue
        candidates.set(channelId, {
          channelId,
          channelName: String((match.channel as { name?: string })?.name ?? channelId),
          channelType: (match.channel as { is_private?: boolean })?.is_private ? 'private' : 'public',
          sourceUrl: typeof match.permalink === 'string' ? match.permalink : null,
        })
      }
    } catch {
      continue
    }
  }

  return [...candidates.values()]
}

async function fetchRecentSlackDms(client: WebClient, afterDate: string): Promise<Array<{
  channelId: string
  channelName: string
  channelType: 'dm' | 'group_dm'
  sourceUrl: string | null
}>> {
  const oldest = Math.floor(new Date(`${afterDate}T00:00:00.000Z`).getTime() / 1000)
  const result = await client.conversations.list({
    types: 'im,mpim',
    limit: Math.max(SLACK_MAX_DMS * 2, 10),
    exclude_archived: true,
  })

  const candidates: Array<{
    channelId: string
    channelName: string
    channelType: 'dm' | 'group_dm'
    sourceUrl: string | null
  }> = []

  for (const conversation of result.channels ?? []) {
    if (!conversation.id) continue
    try {
      const history = await client.conversations.history({
        channel: conversation.id,
        oldest: String(oldest),
        limit: 5,
      })
      if ((history.messages ?? []).length === 0) continue
      candidates.push({
        channelId: conversation.id,
        channelName: conversation.user || conversation.name || conversation.id,
        channelType: conversation.is_mpim ? 'group_dm' : 'dm',
        sourceUrl: null,
      })
    } catch {
      continue
    }
  }

  return candidates
}

async function hydrateSlackMessages(
  client: WebClient,
  messages: Array<{
    user?: string
    text?: string
    ts?: string
  }>
): Promise<Array<{
  ts: string
  userName: string | null
  userEmail: string | null
  text: string
  happenedAt: string | null
}>> {
  const userIds = [...new Set(messages.map(message => String(message.user ?? '')).filter(Boolean))]
  const userMap = await resolveSlackUsers(client, userIds)

  return [...messages]
    .reverse()
    .filter(message => String(message.text ?? '').trim().length > 0)
    .map(message => {
      const userId = String(message.user ?? '')
      return {
        ts: String(message.ts ?? ''),
        userName: userMap.get(userId)?.name ?? null,
        userEmail: userMap.get(userId)?.email ?? null,
        text: String(message.text ?? ''),
        happenedAt: message.ts ? new Date(parseFloat(String(message.ts)) * 1000).toISOString() : null,
      }
    })
}

async function resolveSlackUsers(client: WebClient, userIds: string[]): Promise<Map<string, { name: string; email: string | null }>> {
  const results = await Promise.allSettled(userIds.map(async userId => {
    const info = await client.users.info({ user: userId })
    return {
      userId,
      name: info.user?.real_name || info.user?.name || userId,
      email: info.user?.profile?.email || null,
    }
  }))

  const map = new Map<string, { name: string; email: string | null }>()
  for (const result of results) {
    if (result.status === 'fulfilled') {
      map.set(result.value.userId, {
        name: result.value.name,
        email: result.value.email,
      })
    }
  }
  return map
}

async function fetchGmailThread(accessToken: string, threadId: string): Promise<{
  id: string
  subject: string
  messages: Array<{
    id: string
    subject: string
    from: string
    fromName: string | null
    fromEmail: string | null
    toEmails: string[]
    date: string | null
    snippet: string
    body: string
    labels: string[]
  }>
} | null> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) return null

  const data = await response.json()
  const messages = (data.messages ?? []) as Array<Record<string, unknown>>
  const normalizedMessages = messages.map(message => {
    const headers = ((message.payload as { headers?: Array<{ name: string; value: string }> })?.headers ?? [])
    const subject = findHeader(headers, 'Subject') || '(no subject)'
    const from = findHeader(headers, 'From') || 'unknown'
    const to = findHeader(headers, 'To') || ''
    const fromEmail = extractEmailAddress(from)
    const fromName = extractDisplayName(from)
    return {
      id: String(message.id ?? ''),
      subject,
      from,
      fromName,
      fromEmail,
      toEmails: to.split(',').map(entry => extractEmailAddress(entry)).filter(Boolean) as string[],
      date: toIsoDate(findHeader(headers, 'Date')),
      snippet: String(message.snippet ?? ''),
      body: extractGmailBody((message.payload as Record<string, unknown>) ?? {}),
      labels: mapGmailLabels((message.labelIds as string[]) ?? []),
    }
  })

  return {
    id: threadId,
    subject: normalizedMessages[0]?.subject ?? 'Email thread',
    messages: normalizedMessages,
  }
}

function extractGmailBody(payload: Record<string, unknown>): string {
  const mimeType = String(payload.mimeType ?? '')
  const bodyData = (payload.body as { data?: string } | undefined)?.data

  if (mimeType === 'text/plain' && bodyData) {
    return Buffer.from(bodyData, 'base64url').toString('utf-8')
  }

  const parts = (payload.parts as Array<Record<string, unknown>> | undefined) ?? []
  for (const part of parts) {
    const partMime = String(part.mimeType ?? '')
    const partBody = (part.body as { data?: string } | undefined)?.data
    if (partMime === 'text/plain' && partBody) {
      return Buffer.from(partBody, 'base64url').toString('utf-8')
    }
    if (partMime.startsWith('multipart/')) {
      const nested = extractGmailBody(part)
      if (nested) return nested
    }
  }

  for (const part of parts) {
    const partMime = String(part.mimeType ?? '')
    const partBody = (part.body as { data?: string } | undefined)?.data
    if (partMime === 'text/html' && partBody) {
      return stripHtml(Buffer.from(partBody, 'base64url').toString('utf-8'))
    }
  }

  return ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
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

function mapGmailLabels(labelIds: string[] = []): string[] {
  const map: Record<string, string> = {
    IMPORTANT: 'Important',
    INBOX: 'Inbox',
    UNREAD: 'Unread',
    CATEGORY_PERSONAL: 'Personal',
    CATEGORY_SOCIAL: 'Social',
    CATEGORY_PROMOTIONS: 'Promotions',
    CATEGORY_UPDATES: 'Updates',
    CATEGORY_FORUMS: 'Forums',
    SPAM: 'Spam',
    TRASH: 'Trash',
  }

  return labelIds.map(labelId => map[labelId] ?? labelId).filter(Boolean)
}

function findHeader(headers: Array<{ name: string; value: string }>, name: string): string | null {
  return headers.find(header => header.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function extractEmailAddress(value: string): string | null {
  const match = value.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i)
  return match ? match[0].toLowerCase() : null
}

function extractDisplayName(value: string): string | null {
  const match = value.match(/^(.*?)\s*</)
  return match?.[1]?.trim() || null
}

function extractOutlookBody(message: Record<string, unknown>): string {
  const content = (message.body as { content?: string; contentType?: string } | undefined)?.content || ''
  const contentType = (message.body as { contentType?: string } | undefined)?.contentType
  return contentType === 'html' ? stripHtml(content) : content
}
