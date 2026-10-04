-- BF_SERVER_MEETING_NOTIFY_v741 - Outlook event id for a conference room, and when each person was texted.
ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS graph_event_id text;
ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS host_email text;
ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS texted_at timestamptz;
