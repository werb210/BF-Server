-- 028_lender_submission_normalize.sql
-- Sort key: '028_l' < '028_u' so this runs AFTER 028_add_required_documents
-- and BEFORE 028_users_o365_and_address on every deployment.
--
-- Problem: 028_users_o365_and_address drops the lowercase constraint from 050
-- and tries to add an uppercase one.  On every deployment after the first,
-- existing rows already have lowercase 'email' / 'api' / 'google_sheet' values
-- (set by 050 in the prior run), so the ADD CONSTRAINT fails.
--
-- Fix: drop the constraint here, uppercase all values, add the new constraint.
-- 028_users then does the same DROP/ADD — both are idempotent.

ALTER TABLE IF EXISTS lenders
  DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

UPDATE lenders
SET submission_method = UPPER(submission_method)
WHERE submission_method IS NOT NULL
  AND submission_method <> UPPER(submission_method);

ALTER TABLE IF EXISTS lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (
    submission_method IS NULL
    OR submission_method IN ('EMAIL', 'API', 'GOOGLE_SHEET', 'GOOGLE_SHEETS', 'MANUAL')
  );
