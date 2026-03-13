import { matchesChiefFocus, type ChiefFocusProfile } from '@/lib/intelligence/focus-profile'

const NEWSLETTER_PATTERNS = [
  'unsubscribe',
  'manage preferences',
  'view in browser',
  'substack',
  'newsletter',
  'digest',
  'sponsored',
]

const WORK_KEYWORDS = [
  'meeting',
  'document',
  'rate card',
  'proposal',
  'requirements',
  'deal',
  'contract',
  'follow-up',
  'follow up',
  'scope',
  'timeline',
  'deck',
  'customer',
  'vendor',
  'project',
  'partner',
]

interface EmailCandidate {
  subject: string
  from: string
  labels: string[]
  snippet: string
  body?: string
}

interface SlackConversationCandidate {
  channelType: 'public' | 'private' | 'dm' | 'group_dm'
  participantEmails: string[]
  messages: Array<{ user: string; text: string }>
}

export function isRelevantEmailMessage(email: EmailCandidate, focusProfile?: ChiefFocusProfile): boolean {
  const labels = email.labels.map(label => label.toLowerCase())
  if (labels.some(label => ['promotions', 'social', 'forums', 'spam', 'trash'].includes(label))) {
    return false
  }

  const haystack = `${email.subject} ${email.from} ${email.snippet} ${email.body ?? ''}`.toLowerCase()

  if (NEWSLETTER_PATTERNS.some(pattern => haystack.includes(pattern))) {
    return false
  }

  if (/no-?reply|do-?not-?reply/.test(haystack)) {
    return false
  }

  if (focusProfile?.isActive && matchesChiefFocus(haystack, focusProfile).suppress) {
    return false
  }

  if (WORK_KEYWORDS.some(keyword => haystack.includes(keyword))) {
    return true
  }

  return labels.includes('important') || labels.includes('inbox') || labels.includes('unread')
}

export function isRelevantSlackConversation(conversation: SlackConversationCandidate, focusProfile?: ChiefFocusProfile): boolean {
  const haystack = conversation.messages.map(message => message.text).join(' ').toLowerCase()

  if (focusProfile?.isActive && matchesChiefFocus(haystack, focusProfile).suppress) {
    return false
  }

  if (conversation.channelType === 'dm' || conversation.channelType === 'group_dm') {
    return true
  }

  return WORK_KEYWORDS.some(keyword => haystack.includes(keyword))
}
