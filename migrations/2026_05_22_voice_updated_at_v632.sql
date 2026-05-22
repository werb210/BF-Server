-- BF_SERVER_BLOCK_v632_VOICE_UPDATED_AT_v1
-- Adds missing updated_at columns referenced by recordingWebhooks.ts
-- and triggerVoiceIntelligence. Idempotent.
ALTER TABLE call_recordings  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_call_recordings_updated_at  ON call_recordings(updated_at);
CREATE INDEX IF NOT EXISTS idx_call_transcripts_updated_at ON call_transcripts(updated_at);
