-- ─── Migration 022: Meeting Bot ─────────────────────────────────────────────
-- Adds tables for meeting recording, transcription, AI summarization,
-- and action item extraction. Integrates with existing knowledge graph,
-- commitments, and memory systems.

-- ─── Meetings ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meetings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id   uuid,

  -- Calendar source
  calendar_event_id   text,           -- Google Calendar event ID for dedup
  calendar_provider   text,           -- 'google_calendar' | 'microsoft_calendar'

  -- Meeting details
  title               text NOT NULL,
  meeting_url         text,           -- Google Meet / Zoom URL
  platform            text,           -- 'google_meet' | 'zoom' | 'teams' | null
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  actual_start        timestamptz,    -- When bot joined
  actual_end          timestamptz,    -- When bot left
  duration_seconds    integer,        -- Computed on meeting end

  -- Participants (from calendar invite)
  participants        jsonb DEFAULT '[]'::jsonb,   -- [{ name, email, role? }]
  organizer_email     text,

  -- Bot state
  status              text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN (
      'scheduled',     -- Calendar synced, waiting for start time
      'joining',       -- Bot is connecting to the meeting
      'recording',     -- Bot is in meeting, capturing audio
      'transcribing',  -- Audio recorded, transcription in progress
      'processing',    -- Transcript ready, AI summarization running
      'completed',     -- All artifacts generated
      'failed',        -- Something went wrong
      'skipped'        -- User rule excluded this meeting
    )),
  bot_session_id      text,           -- VPS bot instance identifier
  skip_reason         text,           -- Why status='skipped' (rule name)

  -- Recording
  recording_path      text,           -- Supabase Storage path to audio file
  recording_size_bytes bigint,
  recording_format    text DEFAULT 'webm',

  -- Processing
  transcript_ready    boolean DEFAULT false,
  summary_ready       boolean DEFAULT false,
  error_message       text,
  retry_count         integer DEFAULT 0,

  -- Bot rules snapshot (which rule allowed/skipped this meeting)
  bot_rule_applied    jsonb,

  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- Dedup: one meeting per calendar event per org
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_calendar_dedup
  ON meetings (org_id, calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_org_status
  ON meetings (org_id, status);

CREATE INDEX IF NOT EXISTS idx_meetings_scheduled_start
  ON meetings (scheduled_start)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_meetings_processing
  ON meetings (status)
  WHERE status IN ('transcribing', 'processing');

-- ─── Transcript Segments ────────────────────────────────────────────────────
-- Individual speech segments from the transcription engine.
-- Designed for Supabase Realtime streaming during live meetings.

CREATE TABLE IF NOT EXISTS transcript_segments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,

  speaker        text,             -- Speaker label ('Speaker 0', or matched name)
  speaker_id     integer,          -- Numeric speaker ID from diarization (0, 1, 2...)
  text           text NOT NULL,    -- Transcribed text for this segment

  start_time     float,            -- Seconds from meeting start
  end_time       float,            -- Seconds from meeting start
  confidence     float,            -- ASR confidence score (0-1)

  -- Metadata
  is_final       boolean DEFAULT true,   -- false = interim result (live streaming)
  language       text DEFAULT 'en',
  word_count     integer,

  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcript_meeting_time
  ON transcript_segments (meeting_id, start_time);

CREATE INDEX IF NOT EXISTS idx_transcript_meeting_created
  ON transcript_segments (meeting_id, created_at);

-- Enable Realtime for live transcript streaming
ALTER PUBLICATION supabase_realtime ADD TABLE transcript_segments;

-- ─── Meeting Summaries ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meeting_summaries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Summary tiers
  tldr                text,          -- 1-2 sentence summary
  executive_summary   text,          -- 3-5 bullet points (markdown)
  detailed_summary    text,          -- Full narrative summary (markdown)

  -- Key topics extracted
  topics              jsonb DEFAULT '[]'::jsonb,   -- ['budget review', 'Q3 roadmap', ...]

  -- LLM metadata
  raw_llm_response    jsonb,         -- Full response for debugging
  model_used          text,
  tokens_used         jsonb,         -- { prompt_tokens, completion_tokens }
  cost_usd            float,
  processing_time_ms  integer,

  created_at          timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_summaries_meeting
  ON meeting_summaries (meeting_id);

-- ─── Meeting Action Items ───────────────────────────────────────────────────
-- Extracted from transcript. Can be promoted to commitments table.

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  action              text NOT NULL,        -- What needs to be done
  owner_name          text,                 -- Extracted from transcript (best-effort)
  owner_email         text,                 -- Matched email from participants
  due_date            text,                 -- Explicit or inferred ('by Friday', '2026-03-14')
  priority            text DEFAULT 'P2'     -- 'P0' | 'P1' | 'P2' | 'P3'
    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),

  status              text DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'dismissed', 'promoted')),

  -- Context link back to transcript
  context_quote       text,                 -- Transcript excerpt that sourced this
  context_timestamp   float,                -- Timestamp in recording

  -- Promotion to commitments
  commitment_id       uuid REFERENCES commitments(id),  -- If promoted

  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_actions_meeting
  ON meeting_action_items (meeting_id);

CREATE INDEX IF NOT EXISTS idx_meeting_actions_status
  ON meeting_action_items (org_id, status)
  WHERE status = 'open';

-- ─── Meeting Decisions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meeting_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  decision            text NOT NULL,        -- What was decided
  rationale           text,                 -- Why this decision was made
  decided_by          text,                 -- Who had final authority
  stakeholders        jsonb DEFAULT '[]'::jsonb,  -- People involved

  -- Context link
  context_quote       text,
  context_timestamp   float,

  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_decisions_meeting
  ON meeting_decisions (meeting_id);

-- ─── Bot Configuration ──────────────────────────────────────────────────────
-- Per-org bot rules (which meetings to join, transcription settings, etc.)

CREATE TABLE IF NOT EXISTS meeting_bot_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Join rules
  enabled         boolean DEFAULT true,
  join_mode       text DEFAULT 'all'
    CHECK (join_mode IN (
      'all',             -- Join every meeting with a video link
      'min_attendees',   -- Only meetings with N+ attendees
      'labeled',         -- Only meetings with [record] tag
      'manual'           -- Only manually triggered
    )),
  min_attendees   integer DEFAULT 3,       -- For 'min_attendees' mode
  record_label    text DEFAULT '[record]', -- For 'labeled' mode

  -- Exclusions
  excluded_calendars  jsonb DEFAULT '[]'::jsonb,  -- Calendar IDs to never record
  blocklist_patterns  jsonb DEFAULT '[]'::jsonb,  -- Meeting title patterns to skip

  -- Transcription
  transcription_engine  text DEFAULT 'whisperx'
    CHECK (transcription_engine IN ('whisperx', 'deepgram', 'groq_whisper')),
  language              text DEFAULT 'en',
  enable_diarization    boolean DEFAULT true,

  -- AI summarization
  summarization_model   text DEFAULT 'claude-haiku-4-5-20251001',
  auto_summarize        boolean DEFAULT true,

  -- Notifications
  notify_via_slack      boolean DEFAULT true,
  notify_via_email      boolean DEFAULT false,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  UNIQUE (org_id)
);

-- ─── Speaker Map ────────────────────────────────────────────────────────────
-- Maps diarization speaker IDs to real participant names per meeting.

CREATE TABLE IF NOT EXISTS meeting_speaker_map (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_id      integer NOT NULL,         -- Diarization speaker index (0, 1, 2...)
  speaker_label   text NOT NULL,            -- 'Speaker 0' or matched name
  participant_email text,                   -- Matched participant email
  confidence      float DEFAULT 0.5,        -- Matching confidence

  UNIQUE (meeting_id, speaker_id)
);

-- ─── RLS Policies ───────────────────────────────────────────────────────────

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_bot_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_speaker_map ENABLE ROW LEVEL SECURITY;

-- Helper: Get user's org_id (reuses existing function from earlier migrations)
-- Already exists: user_org_id()

-- Meetings: users see their org's meetings
CREATE POLICY meetings_select ON meetings FOR SELECT
  USING (org_id = user_org_id());
CREATE POLICY meetings_insert ON meetings FOR INSERT
  WITH CHECK (org_id = user_org_id());
CREATE POLICY meetings_update ON meetings FOR UPDATE
  USING (org_id = user_org_id());

-- Service role bypass for VPS bot and cron jobs
CREATE POLICY meetings_service ON meetings FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Transcript segments: read via meeting's org
CREATE POLICY transcript_select ON transcript_segments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.org_id = user_org_id()
  ));
CREATE POLICY transcript_service ON transcript_segments FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Summaries
CREATE POLICY summaries_select ON meeting_summaries FOR SELECT
  USING (org_id = user_org_id());
CREATE POLICY summaries_service ON meeting_summaries FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Action items
CREATE POLICY actions_select ON meeting_action_items FOR SELECT
  USING (org_id = user_org_id());
CREATE POLICY actions_update ON meeting_action_items FOR UPDATE
  USING (org_id = user_org_id());
CREATE POLICY actions_service ON meeting_action_items FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Decisions
CREATE POLICY decisions_select ON meeting_decisions FOR SELECT
  USING (org_id = user_org_id());
CREATE POLICY decisions_service ON meeting_decisions FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Bot config
CREATE POLICY bot_config_select ON meeting_bot_config FOR SELECT
  USING (org_id = user_org_id());
CREATE POLICY bot_config_upsert ON meeting_bot_config FOR ALL
  USING (org_id = user_org_id());
CREATE POLICY bot_config_service ON meeting_bot_config FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- Speaker map
CREATE POLICY speaker_map_select ON meeting_speaker_map FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.org_id = user_org_id()
  ));
CREATE POLICY speaker_map_service ON meeting_speaker_map FOR ALL
  USING (current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role');

-- ─── Updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_meeting_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION update_meeting_updated_at();

CREATE TRIGGER bot_config_updated_at
  BEFORE UPDATE ON meeting_bot_config
  FOR EACH ROW EXECUTE FUNCTION update_meeting_updated_at();

-- ─── Default bot config seed ────────────────────────────────────────────────
-- Insert default config for all existing orgs

INSERT INTO meeting_bot_config (org_id)
SELECT id FROM organizations
ON CONFLICT (org_id) DO NOTHING;
