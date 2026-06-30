-- BF_SERVER_BLOCK_v783_MARKETING_TEMPLATES — named, reusable templates per
-- channel. SMS uses name/body/link_url; email uses name/subject/body/html.
-- The sequence builder selects rows from here by channel.
CREATE TABLE IF NOT EXISTS marketing_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo        text NOT NULL DEFAULT 'BF',
  channel     text NOT NULL,
  name        text NOT NULL,
  body        text,
  link_url    text,
  subject     text,
  html        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mtpl_silo_channel ON marketing_template (silo, channel, updated_at DESC);
