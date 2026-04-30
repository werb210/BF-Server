-- BF_SERVER_v70_BLOCK_1_1 — per-method lender submission config + contact.
-- Email: submission_email
-- API:   api_endpoint + api_key_encrypted
-- Sheet: google_sheet_id
-- Plus contact + address fields the Create Lender form needs.

ALTER TABLE lenders ADD COLUMN IF NOT EXISTS submission_email   TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS api_endpoint       TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS api_key_encrypted  TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS google_sheet_id    TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS contact_name       TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS contact_phone      TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS contact_email      TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS street_address     TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS city_state_zip     TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS main_phone         TEXT;

CREATE INDEX IF NOT EXISTS idx_lenders_submission_method ON lenders(submission_method);
