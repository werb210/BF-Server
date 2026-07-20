-- 2026_07_20_lender_submission_method_case.sql
-- The staff portal PATCH and pwaSyncService write submission_method in
-- LOWERCASE ('google_sheet' | 'email' | 'api'), but the live CHECK constraint
-- only allowed UPPERCASE ('EMAIL','API','GOOGLE_SHEET'). Saving a Google-Sheet
-- lender from the portal therefore returned 409 constraint_violation.
-- Dispatch lowercases submission_method on read, so both cases are
-- functionally identical. Widen the constraint to accept both cases (plus the
-- GOOGLE_SHEETS plural the SubmissionRouter normalises). Existing UPPERCASE
-- rows stay valid. Idempotent: DROP IF EXISTS then ADD.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;
ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
  CHECK (
    submission_method IS NULL
    OR submission_method::text IN (
      'EMAIL','API','GOOGLE_SHEET','GOOGLE_SHEETS',
      'email','api','google_sheet','google_sheets'
    )
  );
