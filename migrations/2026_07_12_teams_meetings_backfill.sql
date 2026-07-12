-- BF_SERVER_TEAMS_MEETINGS_BACKFILL_v2
-- v1 of this file assumed teams_meetings already had every column declared in
-- 2026_07_12_teams_meetings.sql. It does not. runMigrations keys its ledger on
-- FILENAME, so once 2026_07_12_teams_meetings.sql was marked applied its
-- ADD COLUMN IF NOT EXISTS lines could never run again, and the live table was
-- frozen in whatever shape it first got. The backfill INSERT then referenced
-- company_id, hit 42703, and migrations are fatal -> the app crash-looped.
--
-- Rule learned: a migration must assert every column it depends on, never
-- assume an earlier migration's current file contents were applied.
ALTER TABLE teams_meetings
  ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF',
  ADD COLUMN IF NOT EXISTS contact_id UUID,
  ADD COLUMN IF NOT EXISTS company_id UUID,
  ADD COLUMN IF NOT EXISTS crm_meeting_id UUID,
  ADD COLUMN IF NOT EXISTS organizer_user_id UUID,
  ADD COLUMN IF NOT EXISTS organizer_upn TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS graph_event_id TEXT,
  ADD COLUMN IF NOT EXISTS graph_meeting_id TEXT,
  ADD COLUMN IF NOT EXISTS join_url TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recording_url TEXT,
  ADD COLUMN IF NOT EXISTS transcript_text TEXT,
  ADD COLUMN IF NOT EXISTS transcript_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transcript_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maya_summary TEXT,
  ADD COLUMN IF NOT EXISTS maya_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS maya_profile_updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS teams_meetings_contact_idx ON teams_meetings (contact_id, silo);
CREATE INDEX IF NOT EXISTS teams_meetings_pending_idx ON teams_meetings (status, scheduled_end_at);

-- Re-assert the unique index as NON-partial so a bare ON CONFLICT (graph_event_id)
-- is inferable, both below and in crm/meetings.ts.
DROP INDEX IF EXISTS teams_meetings_graph_event_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx
  ON teams_meetings (graph_event_id);

-- Register Teams meetings booked before the ON CONFLICT fix landed. They have a
-- valid Graph event id and a real Teams join URL sitting on crm_meetings, but
-- were never written to teams_meetings, so the transcript poller cannot see them.
INSERT INTO teams_meetings
  (silo, contact_id, company_id, crm_meeting_id, organizer_user_id, organizer_upn,
   subject, graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
SELECT
  COALESCE(m.silo, 'BF'),
  m.contact_id,
  m.company_id,
  m.id,
  m.owner_id,
  COALESCE(u.o365_user_email, u.email),
  m.title,
  m.graph_id,
  m.location,
  m.start_at,
  m.end_at,
  'scheduled'
FROM crm_meetings m
LEFT JOIN users u ON u.id = m.owner_id
WHERE m.graph_id IS NOT NULL
  AND m.location LIKE 'https://teams.microsoft.com/%'
ON CONFLICT (graph_event_id) DO NOTHING;
