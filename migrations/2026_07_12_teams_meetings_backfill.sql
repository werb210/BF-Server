-- BF_SERVER_TEAMS_MEETINGS_BACKFILL_v1
-- Teams meetings booked BEFORE the ON CONFLICT fix landed created a valid Graph
-- event (crm_meetings.graph_id) with a real Teams join URL parked in
-- crm_meetings.location, but the teams_meetings upsert threw and was swallowed,
-- so they were never registered. The fix only helps NEW bookings; these rows
-- would stay invisible to the transcript poller forever. Backfill them.
--
-- Re-assert the unique index first. If the fix migration somehow did not apply,
-- this makes the ON CONFLICT below (and every future upsert) inferable.
DROP INDEX IF EXISTS teams_meetings_graph_event_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx
  ON teams_meetings (graph_event_id);

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
