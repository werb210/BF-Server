-- BF_SERVER_BLOCK_v464_SMS_DELIVERY
-- Twilio accepting a text is not the same as the phone receiving it: US carriers
-- block unregistered senders (30034) seconds later. Every text is recorded here and
-- Twilio's status callback fills in the delivery result, so staff can see it.
CREATE TABLE IF NOT EXISTS sms_deliveries (
  message_sid     TEXT PRIMARY KEY,
  to_number       TEXT,
  kind            TEXT NOT NULL DEFAULT 'sms',
  application_id  TEXT,
  status          TEXT,
  error_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_deliveries_app_kind
  ON sms_deliveries (application_id, kind, created_at DESC);
