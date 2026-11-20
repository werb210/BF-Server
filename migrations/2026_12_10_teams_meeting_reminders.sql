-- BF_SERVER_TEAMS_ATTENDEE_REMINDERS_v1 - Boreal emails Teams meeting attendees 24 hours and 1 hour before.
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS reminder_24h_at timestamptz;
ALTER TABLE teams_meetings ADD COLUMN IF NOT EXISTS reminder_1h_at timestamptz;
