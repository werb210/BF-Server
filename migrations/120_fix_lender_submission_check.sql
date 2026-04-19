-- Fix the lenders_submission_method_check constraint to include all valid methods
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;
ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IN ('email', 'api', 'portal', 'google_sheets', 'EMAIL', 'API', 'PORTAL', 'GOOGLE_SHEETS'));
