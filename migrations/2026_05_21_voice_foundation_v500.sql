-- v500 voice foundation
CREATE TABLE IF NOT EXISTS conferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_conference_sid text UNIQUE,
  friendly_name   text NOT NULL,
  status          text NOT NULL DEFAULT 'init',
  silo            text NOT NULL DEFAULT 'BF',
  created_by_user_id text,
  application_id  text,
  contact_id      text,
  direction       text NOT NULL DEFAULT 'outbound',
  recording_sid   text,
  recording_url   text,
  recording_status text,
  recording_paused boolean NOT NULL DEFAULT false,
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conferences_sid    ON conferences(twilio_conference_sid);
CREATE INDEX IF NOT EXISTS idx_conferences_user   ON conferences(created_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conferences_status ON conferences(status);

CREATE TABLE IF NOT EXISTS conference_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  twilio_call_sid text UNIQUE,
  twilio_participant_label text,
  identity        text,
  phone_number    text,
  kind            text NOT NULL,
  role            text NOT NULL DEFAULT 'participant',
  status          text NOT NULL DEFAULT 'invited',
  muted           boolean NOT NULL DEFAULT false,
  on_hold         boolean NOT NULL DEFAULT false,
  joined_at       timestamptz,
  left_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cparts_conf      ON conference_participants(conference_id);
CREATE INDEX IF NOT EXISTS idx_cparts_call_sid  ON conference_participants(twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_cparts_identity  ON conference_participants(identity);

CREATE TABLE IF NOT EXISTS call_recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid REFERENCES conferences(id) ON DELETE CASCADE,
  twilio_recording_sid text UNIQUE,
  url             text,
  duration_sec    integer,
  channels        integer,
  status          text NOT NULL DEFAULT 'in-progress',
  transcription_sid text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_recordings_conf ON call_recordings(conference_id);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid REFERENCES conferences(id) ON DELETE CASCADE,
  transcription_sid text UNIQUE,
  source          text NOT NULL DEFAULT 'realtime',
  status          text NOT NULL DEFAULT 'in-progress',
  full_text       text,
  segments_json   jsonb,
  voice_intelligence_sid text,
  voice_intelligence_summary text,
  pii_redacted_text text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_transcripts_conf ON call_transcripts(conference_id);
