-- BF_SERVER_MEETING_ROOMS_v736 - dial-in conference rooms. Each meeting has a 6-digit access
-- code callers enter on the 866 line (option 3), and a private link to a join page.
CREATE TABLE IF NOT EXISTS meeting_rooms (
  id             uuid PRIMARY KEY,
  code           text NOT NULL,
  slug           text NOT NULL UNIQUE,
  title          text NOT NULL,
  host_user_id   uuid,
  application_id text,
  contact_id     uuid,
  starts_at      timestamptz NOT NULL,
  duration_min   integer NOT NULL DEFAULT 60,
  status         text NOT NULL DEFAULT 'scheduled',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_rooms_code_idx ON meeting_rooms (code);
CREATE INDEX IF NOT EXISTS meeting_rooms_starts_idx ON meeting_rooms (starts_at);
