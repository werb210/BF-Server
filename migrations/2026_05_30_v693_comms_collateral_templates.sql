-- v693: comms layer — per-user booking link, collateral library, message templates.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS booking_url text;

CREATE TABLE IF NOT EXISTS collateral_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  audience     text,
  doc_type     text,
  blob_name    text NOT NULL,
  content_type text,
  size_bytes   bigint,
  silo         text NOT NULL DEFAULT 'BF',
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collateral_silo ON collateral_assets (silo, created_at DESC);

CREATE TABLE IF NOT EXISTS message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL CHECK (channel IN ('email','message','sms')),
  name          text NOT NULL,
  subject       text,
  body_html     text,
  body_text     text,
  shared        boolean NOT NULL DEFAULT true,
  owner_user_id uuid,
  silo          text NOT NULL DEFAULT 'BF',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_templates_lookup ON message_templates (silo, channel);
