-- BF_EMAIL_TEMPLATE_TABLE_v1
CREATE TABLE IF NOT EXISTS marketing_email_template (
  silo         text PRIMARY KEY,
  headline     text NOT NULL DEFAULT '',
  hero_url     text NOT NULL DEFAULT '',
  hero_link    text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  cta_label    text NOT NULL DEFAULT '',
  cta_url      text NOT NULL DEFAULT '',
  image2_url   text NOT NULL DEFAULT '',
  image2_link  text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
