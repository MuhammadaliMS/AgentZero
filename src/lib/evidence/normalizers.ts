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
