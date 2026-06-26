-- BF_SERVER_SMS_CAMPAIGN_v1 - bulk SMS + 36h fallback-email cascade.
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sms_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  tag text NULL,
  sms_body text NOT NULL,
  link_url text NULL,
  fallback_subject text NULL,
  fallback_html text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  silo text NOT NULL DEFAULT 'BF',
  phone text NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  message_sid text NULL,
  delivery_status text NULL,
  clicked_at timestamptz NULL,
  fallback_sent boolean NOT NULL DEFAULT false,
  fallback_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS sms_sends_cascade_idx ON sms_campaign_sends (sent_at) WHERE fallback_sent = false AND clicked_at IS NULL;
CREATE INDEX IF NOT EXISTS sms_sends_sid_idx ON sms_campaign_sends (message_sid);
