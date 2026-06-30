-- BF_SERVER_BLOCK_v786_SEQ_CLICKS — per-send tracking for sequence SMS so a
-- tracked-link click attributes back to the contact (sms_campaign_sends can't be
-- reused: its campaign_id is a required FK).
CREATE TABLE IF NOT EXISTS sequence_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id     uuid NOT NULL,
  contact_id      uuid NOT NULL,
  silo            text NOT NULL DEFAULT 'BF',
  channel         text NOT NULL DEFAULT 'sms',
  message_sid     text NULL,
  delivery_status text NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  clicked_at      timestamptz NULL
);
CREATE INDEX IF NOT EXISTS sequence_sends_contact_idx ON sequence_sends (contact_id, clicked_at);
CREATE INDEX IF NOT EXISTS sequence_sends_sid_idx ON sequence_sends (message_sid);
