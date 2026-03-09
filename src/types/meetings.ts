// ─── Meeting Bot Types ──────────────────────────────────────────────────────
// Manually maintained types for the meeting bot tables (migration 022).
// These complement the auto-generated database.ts from Supabase CLI.
// Once you run `supabase gen types`, these will be available in Database['public']['Tables'].

import type { Json } from './database'

// ─── Meetings ─────────────────────────────────────────────────────────────

export type MeetingStatus =
  | 'scheduled'
  | 'joining'
  | 'recording'
  | 'transcribing'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped'

export type MeetingPlatform = 'google_meet' | 'zoom' | 'teams'

export interface Meeting {
  id: string
  org_id: string
  workspace_id: string | null
  calendar_event_id: string | null
  calendar_provider: string | null
  title: string
  meeting_url: string | null
  platform: MeetingPlatform | null
  scheduled_start: string | null
  scheduled_end: string | null
  actual_start: string | null
  actual_end: string | null
  duration_seconds: number | null
  participants: MeetingParticipant[]
  organizer_email: string | null
  status: MeetingStatus
  bot_session_id: string | null
  skip_reason: string | null
  recording_path: string | null
  recording_size_bytes: number | null
  recording_format: string
  transcript_ready: boolean
  summary_ready: boolean
  error_message: string | null
  retry_count: number
  bot_rule_applied: Json | null
  created_at: string
  updated_at: string
}

export interface MeetingParticipant {
  name: string
  email: string
  role?: string
}

export interface MeetingInsert {
  org_id: string
  workspace_id?: string | null
  calendar_event_id?: string | null
  calendar_provider?: string | null
  title: string
  meeting_url?: string | null
  platform?: MeetingPlatform | null
  scheduled_start?: string | null
  scheduled_end?: string | null
  actual_start?: string | null
  actual_end?: string | null
  duration_seconds?: number | null
  participants?: MeetingParticipant[]
  organizer_email?: string | null
  status?: MeetingStatus
  bot_session_id?: string | null
  skip_reason?: string | null
  recording_path?: string | null
  recording_size_bytes?: number | null
  recording_format?: string
  transcript_ready?: boolean
  summary_ready?: boolean
  error_message?: string | null
  retry_count?: number
  bot_rule_applied?: Json | null
}

// ─── Transcript Segments ──────────────────────────────────────────────────

export interface TranscriptSegment {
  id: string
  meeting_id: string
  speaker: string | null
  speaker_id: number | null
  text: string
  start_time: number | null
  end_time: number | null
  confidence: number | null
  is_final: boolean
  language: string
  word_count: number | null
  created_at: string
}

export interface TranscriptSegmentInsert {
  meeting_id: string
  speaker?: string | null
  speaker_id?: number | null
  text: string
  start_time?: number | null
  end_time?: number | null
  confidence?: number | null
  is_final?: boolean
  language?: string
  word_count?: number | null
}

// ─── Meeting Summaries ────────────────────────────────────────────────────

export interface MeetingSummary {
  id: string
  meeting_id: string
  org_id: string
  tldr: string | null
  executive_summary: string | null
  detailed_summary: string | null
  topics: string[]
  raw_llm_response: Json | null
  model_used: string | null
  tokens_used: { prompt_tokens: number; completion_tokens: number } | null
  cost_usd: number | null
  processing_time_ms: number | null
  created_at: string
}

// ─── Action Items ─────────────────────────────────────────────────────────

export type ActionItemPriority = 'P0' | 'P1' | 'P2' | 'P3'
export type ActionItemStatus = 'open' | 'completed' | 'dismissed' | 'promoted'

export interface MeetingActionItem {
  id: string
  meeting_id: string
  org_id: string
  action: string
  owner_name: string | null
  owner_email: string | null
  owner_entity_id: string | null
  due_date: string | null
  priority: ActionItemPriority
  status: ActionItemStatus
  context_quote: string | null
  context_timestamp: number | null
  commitment_id: string | null
  created_at: string
}

// ─── Decisions ────────────────────────────────────────────────────────────

export interface MeetingDecision {
  id: string
  meeting_id: string
  org_id: string
  decision: string
  rationale: string | null
  decided_by: string | null
  decided_by_entity_id: string | null
  stakeholders: string[]
  context_quote: string | null
  context_timestamp: number | null
  created_at: string
}

// ─── Bot Configuration ────────────────────────────────────────────────────

export type JoinMode = 'all' | 'min_attendees' | 'labeled' | 'manual'
export type TranscriptionEngine = 'whisperx' | 'deepgram' | 'groq_whisper'

export interface MeetingBotConfig {
  id: string
  org_id: string
  enabled: boolean
  join_mode: JoinMode
  min_attendees: number
  record_label: string
  excluded_calendars: string[]
  blocklist_patterns: string[]
  transcription_engine: TranscriptionEngine
  language: string
  enable_diarization: boolean
  summarization_model: string
  auto_summarize: boolean
  notify_via_slack: boolean
  notify_via_email: boolean
  created_at: string
  updated_at: string
}

// ─── Speaker Map ──────────────────────────────────────────────────────────

export interface MeetingSpeakerMap {
  id: string
  meeting_id: string
  speaker_id: number
  speaker_label: string
  participant_email: string | null
  confidence: number
}

// ─── API Types (webhook payloads, etc.) ───────────────────────────────────

export interface MeetingWebhookPayload {
  meeting_id: string
  event: 'recording_complete' | 'transcription_complete' | 'bot_error'
  recording_path?: string
  recording_size_bytes?: number
  duration_seconds?: number
  segment_count?: number
  error_message?: string
}

// ─── Meeting with relations (common query shapes) ─────────────────────────

export interface MeetingWithSummary extends Meeting {
  summary: MeetingSummary | null
  action_items: MeetingActionItem[]
  decisions: MeetingDecision[]
}

export interface MeetingListItem {
  id: string
  title: string
  platform: MeetingPlatform | null
  scheduled_start: string | null
  duration_seconds: number | null
  status: MeetingStatus
  participants: MeetingParticipant[]
  summary_ready: boolean
  action_item_count?: number
  decision_count?: number
}
