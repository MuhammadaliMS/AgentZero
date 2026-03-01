import type { KnownBlock } from '@slack/web-api'

/**
 * Wrap agent-generated markdown text into Slack Block Kit blocks.
 * Slack mrkdwn sections have a 3000-char limit, so we chunk long text.
 */
export function buildAgentTextBlocks(options: {
  header: string
  text: string
  footerText?: string
  appUrl?: string
}): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: options.header, emoji: true },
    },
  ]

  const MAX = 2900
  const chunks: string[] = []
  let remaining = options.text.trim()
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      chunks.push(remaining)
      break
    }
    const cutAt = remaining.lastIndexOf('\n', MAX)
    const breakAt = cutAt > 0 ? cutAt : MAX
    chunks.push(remaining.slice(0, breakAt).trim())
    remaining = remaining.slice(breakAt).trim()
  }

  for (const chunk of chunks) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } })
  }

  blocks.push({ type: 'divider' })

  if (options.footerText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: options.footerText }] })
  }

  if (options.appUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Captain' },
          url: options.appUrl,
          action_id: 'open_console',
        },
      ],
    } as KnownBlock)
  }

  return blocks
}

export function buildMorningBriefBlocks(brief: {
  greeting: string
  sections: Array<{ title: string; items: string[] }>
  closingNote?: string
}): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Good Morning — Your Daily Brief' } },
    { type: 'section', text: { type: 'mrkdwn', text: brief.greeting } },
    { type: 'divider' },
  ]

  for (const section of brief.sections) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${section.title}*\n${section.items.map((i) => `• ${i}`).join('\n')}` },
    })
  }

  if (brief.closingNote) {
    blocks.push({ type: 'divider' }, { type: 'context', elements: [{ type: 'mrkdwn', text: brief.closingNote }] })
  }

  return blocks
}

export function buildApprovalBlocks(action: {
  title: string
  description: string
  actionId: string
  priority?: string
}): KnownBlock[] {
  const priorityEmoji: Record<string, string> = {
    critical: ':rotating_light:',
    high: ':red_circle:',
    medium: ':large_orange_circle:',
    low: ':white_circle:',
  }

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${action.priority ? priorityEmoji[action.priority] + ' ' : ''}Action Required` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*${action.title}*\n\n${action.description}` } },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_action', value: action.actionId },
        { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', action_id: 'reject_action', value: action.actionId },
        { type: 'button', text: { type: 'plain_text', text: 'Defer' }, action_id: 'defer_action', value: action.actionId },
      ],
    },
  ]
}

export function buildResolvedBlocks(action: {
  title: string
  resolution: 'approved' | 'rejected' | 'deferred'
  resolvedBy: string
}): KnownBlock[] {
  const statusEmoji = { approved: ':white_check_mark:', rejected: ':x:', deferred: ':hourglass:' }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji[action.resolution]} *${action.title}*\n_${action.resolution.charAt(0).toUpperCase() + action.resolution.slice(1)} by ${action.resolvedBy}_`,
      },
    },
  ]
}

export function buildEodWrapBlocks(wrap: {
  summary: string
  completedToday: string[]
  carryForward: string[]
  tomorrowPreview?: string
}): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'End of Day Wrap' } },
    { type: 'section', text: { type: 'mrkdwn', text: wrap.summary } },
  ]

  if (wrap.completedToday.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Completed Today*\n${wrap.completedToday.map((i) => `• ${i}`).join('\n')}` } })
  }
  if (wrap.carryForward.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Carrying Forward*\n${wrap.carryForward.map((i) => `• ${i}`).join('\n')}` } })
  }
  if (wrap.tomorrowPreview) {
    blocks.push({ type: 'divider' }, { type: 'context', elements: [{ type: 'mrkdwn', text: `*Tomorrow:* ${wrap.tomorrowPreview}` }] })
  }

  return blocks
}
