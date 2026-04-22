-- Canonicalize and enforce valid lender submission methods.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

UPDATE lenders
SET submission_method = 'EMAIL'
WHERE submission_method IS NULL OR submission_method::text NOT IN ('EMAIL','API','PORTAL','MANUAL');

ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IN ('EMAIL','API','PORTAL','MANUAL'));
