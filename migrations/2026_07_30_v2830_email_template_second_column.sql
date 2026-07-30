-- BF_EMAIL_TEMPLATE_SECOND_COLUMN_v1
ALTER TABLE marketing_email_template
  ADD COLUMN IF NOT EXISTS headline2        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS body2            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS right_image_url  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS right_image_link text NOT NULL DEFAULT '';
