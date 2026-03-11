import crypto from 'node:crypto'

import type { ArtifactChannel } from '@/lib/evidence/schema'

type JsonObject = Record<string, unknown>

export interface NormalizedArtifact {
  orgId: string
  channel: ArtifactChannel
  externalId: string
  title: string
  sourceUrl: string | null
  startedAt: string | null
  endedAt: string | null
  rawRef: string | null
  metadata: JsonObject
}

export interface NormalizedEvidenceItem {
  sequenceNo: number
  authorName: string | null
  happenedAt: string | null
  text: string
  sourceAnchor: string
  artifactChannel: ArtifactChannel
  metadata: JsonObject
}

interface MeetingParticipant {
  name?: string
  email?: string
}

interface MeetingLike {
  id: string
  title: string
  scheduled_start?: string | null
  actual_end?: string | null
  meeting_url?: string | null
  participants?: MeetingParticipant[] | null
}

interface MeetingSegmentLike {
  id: string
  speaker?: string | null
  text: string
  start_time?: number | null
  end_time?: number | null
  created_at?: string | null
}

export function normalizeMeetingArtifact(input: {
  orgId: string
  meeting: MeetingLike
  segments: MeetingSegmentLike[]
}): {
  artifact: NormalizedArtifact
  evidenceItems: NormalizedEvidenceItem[]
} {
  const artifact: NormalizedArtifact = {
    orgId: input.orgId,
    channel: 'meeting',
    externalId: input.meeting.id,
    title: input.meeting.title,
    sourceUrl: input.meeting.meeting_url ?? null,
    startedAt: input.meeting.scheduled_start ?? null,
    endedAt: input.meeting.actual_end ?? null,
    rawRef: `meeting:${input.meeting.id}`,
    metadata: {
      meetingId: input.meeting.id,
      participants: (input.meeting.participants ?? []).map(participant => ({
        name: participant.name ?? null,
        email: participant.email ?? null,
      })),
    },
  }

  const evidenceItems = input.segments.map((segment, index) => ({
    sequenceNo: index + 1,
    authorName: segment.speaker ?? null,
    happenedAt: segment.created_at ?? null,
    text: segment.text.trim(),
    sourceAnchor: `segment:${segment.id}`,
    artifactChannel: 'meeting' as const,
    metadata: {
      meetingId: input.meeting.id,
      segmentId: segment.id,
      startTime: segment.start_time ?? null,
      endTime: segment.end_time ?? null,
    },
  }))

  return { artifact, evidenceItems }
}

interface ConversationLike {
  id: string
  title?: string | null
  created_at?: string | null
  updated_at?: string | null
}

interface MessageLike {
  id: string
  role: string
  content: string
  created_at?: string | null
}

interface ToolOutputLike {
  toolName: string
  output: string
}

interface EmailThreadLike {
  id: string
  subject: string
  participants?: string[]
  sourceUrl?: string | null
}

interface EmailMessageLike {
  id: string
  authorName?: string | null
  authorEmail?: string | null
  text: string
  happenedAt?: string | null
}

interface SlackConversationLike {
  channelId: string
  channelName: string
  channelType: 'public' | 'private' | 'dm' | 'group_dm'
  threadTs?: string | null
  sourceUrl?: string | null
}

interface SlackMessageLike {
  ts: string
  userName?: string | null
  userEmail?: string | null
  text: string
  happenedAt?: string | null
}

export function normalizeChatArtifact(input: {
  orgId: string
  conversation: ConversationLike
  messages: MessageLike[]
  toolOutputs?: ToolOutputLike[]
}): {
  artifact: NormalizedArtifact
  evidenceItems: NormalizedEvidenceItem[]
} {
  const sliceId = input.messages[input.messages.length - 1]?.id ?? input.conversation.id
  const artifact: NormalizedArtifact = {
    orgId: input.orgId,
    channel: 'chat',
    externalId: `${input.conversation.id}:${sliceId}`,
    title: input.conversation.title?.trim() || `Conversation ${input.conversation.id}`,
    sourceUrl: null,
    startedAt: input.conversation.created_at ?? null,
    endedAt: input.conversation.updated_at ?? null,
    rawRef: `conversation:${input.conversation.id}:slice:${sliceId}`,
    metadata: {
      conversationId: input.conversation.id,
      conversationSliceId: sliceId,
    },
  }

  const messageItems = input.messages.map((message, index) => ({
    sequenceNo: index + 1,
    authorName: message.role,
    happenedAt: message.created_at ?? null,
    text: message.content.trim(),
    sourceAnchor: `message:${message.id}`,
    artifactChannel: 'chat' as const,
    metadata: {
      conversationId: input.conversation.id,
      messageId: message.id,
      role: message.role,
    },
  }))

  const toolItems = (input.toolOutputs ?? []).map((toolOutput, index) => ({
    sequenceNo: input.messages.length + index + 1,
    authorName: `tool:${toolOutput.toolName}`,
    happenedAt: input.conversation.updated_at ?? null,
    text: toolOutput.output,
    sourceAnchor: `tool:${toolOutput.toolName}:${index + 1}`,
    artifactChannel: inferArtifactChannel(toolOutput.toolName),
    metadata: {
      conversationId: input.conversation.id,
      toolName: toolOutput.toolName,
    },
  }))

  return {
    artifact,
    evidenceItems: [...messageItems, ...toolItems],
  }
}

export function normalizeEmailArtifact(input: {
  orgId: string
  provider: 'gmail' | 'microsoft_365'
  thread: EmailThreadLike
  messages: EmailMessageLike[]
}): {
  artifact: NormalizedArtifact
  evidenceItems: NormalizedEvidenceItem[]
} {
  const artifact: NormalizedArtifact = {
    orgId: input.orgId,
    channel: 'email',
    externalId: `${input.provider}:${input.thread.id}`,
    title: input.thread.subject?.trim() || `Email thread ${input.thread.id}`,
    sourceUrl: input.thread.sourceUrl ?? null,
    startedAt: input.messages[0]?.happenedAt ?? null,
    endedAt: input.messages[input.messages.length - 1]?.happenedAt ?? null,
    rawRef: `email:${input.provider}:${input.thread.id}`,
    metadata: {
      provider: input.provider,
      threadId: input.thread.id,
      participants: input.thread.participants ?? [],
    },
  }

  const evidenceItems = input.messages.map((message, index) => ({
    sequenceNo: index + 1,
    authorName: message.authorName ?? message.authorEmail ?? null,
    happenedAt: message.happenedAt ?? null,
    text: message.text.trim(),
    sourceAnchor: `message:${message.id}`,
    artifactChannel: 'email' as const,
    metadata: {
      provider: input.provider,
      messageId: message.id,
      authorEmail: message.authorEmail ?? null,
      threadId: input.thread.id,
    },
  }))

  return { artifact, evidenceItems }
}

export function normalizeSlackArtifact(input: {
  orgId: string
  conversation: SlackConversationLike
  messages: SlackMessageLike[]
}): {
  artifact: NormalizedArtifact
  evidenceItems: NormalizedEvidenceItem[]
} {
  const externalId = input.conversation.threadTs
    ? `slack:${input.conversation.channelId}:${input.conversation.threadTs}`
    : `slack:${input.conversation.channelId}:${input.messages[0]?.happenedAt?.slice(0, 10) ?? 'undated'}`

  const artifact: NormalizedArtifact = {
    orgId: input.orgId,
    channel: 'slack',
    externalId,
    title: input.conversation.channelName,
    sourceUrl: input.conversation.sourceUrl ?? null,
    startedAt: input.messages[0]?.happenedAt ?? null,
    endedAt: input.messages[input.messages.length - 1]?.happenedAt ?? null,
    rawRef: input.conversation.threadTs
      ? `slack:${input.conversation.channelId}:thread:${input.conversation.threadTs}`
      : `slack:${input.conversation.channelId}:slice`,
    metadata: {
      channelId: input.conversation.channelId,
      channelName: input.conversation.channelName,
      channelType: input.conversation.channelType,
      threadTs: input.conversation.threadTs ?? null,
    },
  }

  const evidenceItems = input.messages.map((message, index) => ({
    sequenceNo: index + 1,
    authorName: message.userName ?? message.userEmail ?? null,
    happenedAt: message.happenedAt ?? null,
    text: message.text.trim(),
    sourceAnchor: `message:${message.ts}`,
    artifactChannel: 'slack' as const,
    metadata: {
      channelId: input.conversation.channelId,
      channelType: input.conversation.channelType,
      userEmail: message.userEmail ?? null,
      ts: message.ts,
      threadTs: input.conversation.threadTs ?? null,
    },
  }))

  return { artifact, evidenceItems }
}

export function buildClaimKey(input: {
  orgId: string
  claimKind: string
  subjectEntityId: string
  predicate: string
  objectEntityId?: string | null
  objectValue?: string | null
  artifactId?: string | null
}): string {
  const parts = [
    input.orgId,
    input.claimKind,
    input.subjectEntityId,
    input.predicate,
    input.objectEntityId ?? '',
    input.objectValue ?? '',
    input.artifactId ?? '',
  ]

  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

function inferArtifactChannel(toolName: string): ArtifactChannel {
  if (toolName.includes('slack')) return 'slack'
  if (toolName.includes('email')) return 'email'
  return 'chat'
}
