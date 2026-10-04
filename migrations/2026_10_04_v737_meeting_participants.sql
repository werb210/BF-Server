-- BF_SERVER_MEETING_PARTICIPANTS_v737 - who is invited to a conference room (host included,
-- at most 10 people per room). A participant is a CRM contact, a staff user, or typed in.
CREATE TABLE IF NOT EXISTS meeting_participants (
  id          uuid PRIMARY KEY,
  room_id     uuid NOT NULL,
  contact_id  uuid,
  user_id     uuid,
  name        text NOT NULL,
  email       text,
  phone       text,
  invited_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_participants_room_idx ON meeting_participants (room_id);
