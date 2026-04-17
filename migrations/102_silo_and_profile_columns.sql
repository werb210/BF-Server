ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name            text,
  ADD COLUMN IF NOT EXISTS last_name             text,
  ADD COLUMN IF NOT EXISTS status                text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS silo                  text,
  ADD COLUMN IF NOT EXISTS last_login_at         timestamptz,
  ADD COLUMN IF NOT EXISTS o365_user_email       text,
  ADD COLUMN IF NOT EXISTS o365_access_token     text,
  ADD COLUMN IF NOT EXISTS o365_token_expires_at timestamptz;

UPDATE users
  SET first_name = split_part(email, '@', 1)
  WHERE first_name IS NULL AND email IS NOT NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';

ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS eligibility_notes   text,
  ADD COLUMN IF NOT EXISTS signnow_template_id text;

ALTER TABLE lenders
  ADD COLUMN IF NOT EXISTS street      text,
  ADD COLUMN IF NOT EXISTS city        text,
  ADD COLUMN IF NOT EXISTS region      text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS phone       text;

ALTER TABLE lenders
  DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

ALTER TABLE lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IS NULL
      OR submission_method IN ('EMAIL','API','GOOGLE_SHEET','MANUAL'));
