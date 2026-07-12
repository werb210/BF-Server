-- BF_SERVER_TEAMS_MEETINGS_v1 - Teams meeting -> CRM intelligence.
-- Links a Graph online meeting to the contact it was booked with, so when the
-- recording + transcript land we know whose timeline to attach them to.
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS teams_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  silo TEXT NOT NULL DEFAULT 'BF',
  contact_id UUID,
  lender_id UUID,
  organizer_user_id UUID,
  organizer_upn TEXT,
  subject TEXT,
  graph_event_id TEXT,
  graph_meeting_id TEXT,
  join_url TEXT,
  scheduled_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  recording_url TEXT,
  transcript_text TEXT,
  transcript_fetched_at TIMESTAMPTZ,
  maya_summary TEXT,
  maya_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  maya_profile_updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS lender_id UUID;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS organizer_upn TEXT;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS maya_profile_updates JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS teams_meetings_contact_idx ON teams_meetings (contact_id, silo);
CREATE INDEX IF NOT EXISTS teams_meetings_status_idx ON teams_meetings (status, scheduled_end_at);
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx
  ON teams_meetings (graph_event_id) WHERE graph_event_id IS NOT NULL;
