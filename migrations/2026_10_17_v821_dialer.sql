-- BF_SERVER_v821_DIALER - per-staff "do not disturb by hours" for calls that ring one person (direct line, named
-- reception target, the engagement group). Separate from presenceService's business hours (America/Regina on
-- purpose, see albertaTime.ts); this one uses the staff member's own IANA time zone.
--   weekly: {"mon":[["08:00","18:00"]], "tue":[...], ..., "sat":[], "sun":[]} - up to 3 ranges a day, HH:MM, start < end.
-- Idempotent.
CREATE TABLE IF NOT EXISTS staff_call_hours (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'America/Edmonton',
  weekly jsonb NOT NULL DEFAULT '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[],"sun":[]}'::jsonb,
  urgent_passthrough boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
