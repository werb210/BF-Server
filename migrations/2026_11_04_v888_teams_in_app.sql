-- BF_SERVER_v888_TEAMS_IN_APP
-- Clients can now join their Teams meetings inside the client app, and every Teams
-- booking made through "Book a call" is registered in teams_meetings (so the existing
-- transcript poller attaches the recording link, transcript and Maya summary). Bookings
-- made before this release only live in client_bookings; copy them across once.
--
-- Asserts every column it uses (the migration ledger is keyed on filename, so an earlier
-- file's ADD COLUMN lines may never have run against this database). Idempotent.
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS attendees_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS crm_meeting_id uuid;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS graph_event_id text;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS join_url text;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'booked';

ALTER TABLE teams_meetings
  ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF',
  ADD COLUMN IF NOT EXISTS contact_id UUID,
  ADD COLUMN IF NOT EXISTS crm_meeting_id UUID,
  ADD COLUMN IF NOT EXISTS organizer_user_id UUID,
  ADD COLUMN IF NOT EXISTS organizer_upn TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS graph_event_id TEXT,
  ADD COLUMN IF NOT EXISTS join_url TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled';

CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx ON teams_meetings (graph_event_id);
CREATE INDEX IF NOT EXISTS teams_meetings_crm_meeting_idx ON teams_meetings (crm_meeting_id);
CREATE INDEX IF NOT EXISTS client_bookings_crm_meeting_idx ON client_bookings (crm_meeting_id);

INSERT INTO teams_meetings
  (silo, contact_id, crm_meeting_id, organizer_user_id, organizer_upn,
   subject, graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
SELECT 'BF', b.contact_id, b.crm_meeting_id, b.staff_user_id, b.staff_email,
       COALESCE(m.title, 'Teams meeting with ' || b.client_name),
       b.graph_event_id, b.join_url, b.starts_at,
       b.starts_at + make_interval(mins => COALESCE(b.duration_min, 30)),
       'scheduled'
  FROM client_bookings b
  LEFT JOIN crm_meetings m ON m.id = b.crm_meeting_id
 WHERE b.kind = 'teams'
   AND b.graph_event_id IS NOT NULL
   AND b.join_url IS NOT NULL
   AND b.status NOT IN ('failed', 'cancelled')
ON CONFLICT (graph_event_id) DO NOTHING;
