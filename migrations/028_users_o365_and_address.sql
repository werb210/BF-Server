-- Users: O365 token storage
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS o365_user_email       text null,
  ADD COLUMN IF NOT EXISTS o365_access_token     text null,
  ADD COLUMN IF NOT EXISTS o365_token_expires_at timestamptz null;

-- Lenders: address fields (already in 027 but guard with IF NOT EXISTS)
ALTER TABLE lenders
  ADD COLUMN IF NOT EXISTS street      text null,
  ADD COLUMN IF NOT EXISTS city        text null,
  ADD COLUMN IF NOT EXISTS region      text null,
  ADD COLUMN IF NOT EXISTS postal_code text null,
  ADD COLUMN IF NOT EXISTS phone       text null;

-- Lender products: eligibility notes and signnow template
ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS eligibility_notes   text null,
  ADD COLUMN IF NOT EXISTS signnow_template_id text null;

-- Allow GOOGLE_SHEET as a submission_method (drop old 2-value constraint, add new one)
ALTER TABLE lenders
  DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

ALTER TABLE lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IS NULL OR submission_method IN ('EMAIL','API','GOOGLE_SHEET','MANUAL'));
