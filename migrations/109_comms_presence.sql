-- Staff presence for inbound call routing
CREATE TABLE IF NOT EXISTS staff_presence (
  user_id         uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'offline'
                              CHECK (status IN ('available', 'busy', 'offline')),
  twilio_identity text        NULL,
  last_heartbeat  timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_presence_status_idx ON staff_presence (status);
CREATE INDEX IF NOT EXISTS staff_presence_heartbeat_idx ON staff_presence (last_heartbeat);

-- communications_messages — add phone + twilio SID columns needed for inbound SMS
ALTER TABLE IF EXISTS communications_messages
  ADD COLUMN IF NOT EXISTS from_number      text,
  ADD COLUMN IF NOT EXISTS to_number        text,
  ADD COLUMN IF NOT EXISTS phone_number     text,
  ADD COLUMN IF NOT EXISTS twilio_sid       text,
  ADD COLUMN IF NOT EXISTS contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS comm_messages_contact_idx  ON communications_messages (contact_id);
CREATE INDEX IF NOT EXISTS comm_messages_phone_idx    ON communications_messages (phone_number);
CREATE UNIQUE INDEX IF NOT EXISTS comm_messages_twilio_sid_idx
  ON communications_messages (twilio_sid) WHERE twilio_sid IS NOT NULL;

-- voicemails — ensure core columns present
ALTER TABLE IF EXISTS voicemails
  ADD COLUMN IF NOT EXISTS contact_id      uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS application_id  text NULL REFERENCES applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transcription   text NULL,
  ADD COLUMN IF NOT EXISTS recording_url   text NULL,
  ADD COLUMN IF NOT EXISTS recording_sid   text NULL,
  ADD COLUMN IF NOT EXISTS duration        integer NULL,
  ADD COLUMN IF NOT EXISTS from_number     text NULL;
