-- BF_SERVER_TEAMS_MEETINGS_v1 - Teams meeting -> CRM intelligence.
-- The CRM Meeting popup already creates a real Graph calendar event with
-- isOnlineMeeting=true (BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1) and stores the
-- join link on crm_meetings. What it never recorded was the Graph event id
-- paired with the ORGANIZER, which is exactly what the transcript/recording
-- endpoints key on. This table carries that link plus the artifacts we pull
-- back. Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS teams_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  silo TEXT NOT NULL DEFAULT 'BF',
  contact_id UUID,
  company_id UUID,
  crm_meeting_id UUID,
  organizer_user_id UUID,
  organizer_upn TEXT,
  subject TEXT,
  graph_event_id TEXT,
  graph_meeting_id TEXT,
  join_url TEXT,
  scheduled_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  recording_url TEXT,
  transcript_text TEXT,
  transcript_fetched_at TIMESTAMPTZ,
  transcript_attempts INT NOT NULL DEFAULT 0,
  maya_summary TEXT,
  maya_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  maya_profile_updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS crm_meeting_id UUID;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS organizer_upn TEXT;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS transcript_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS maya_profile_updates JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS teams_meetings_contact_idx ON teams_meetings (contact_id, silo);
CREATE INDEX IF NOT EXISTS teams_meetings_pending_idx ON teams_meetings (status, scheduled_end_at);
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx
  ON teams_meetings (graph_event_id) WHERE graph_event_id IS NOT NULL;
