-- BF_SERVER_v935_SMS_PLAIN_SEGMENTS - short tracked links for marketing texts. The old link carried a signed token of
-- about 200 characters, which alone added two or three billed segments to every text. Safe to run again.
CREATE TABLE IF NOT EXISTS sms_short_links (
  code       text PRIMARY KEY,
  send_id    uuid,
  url        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_short_links_created_idx ON sms_short_links (created_at);
