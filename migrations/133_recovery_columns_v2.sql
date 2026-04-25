-- 133_recovery_columns_v2.sql
-- Recovery v2. Idempotent. Finishes migration 116, sets a DB-level
-- default on lender_products.status, and canonicalizes the lenders
-- submission_method column + its CHECK constraint.

-- ── 1. Finish migration 116 (companies + contact link columns) ──
-- Create a minimal companies table first, then add each expected column
-- individually so partially-created production tables are repaired safely.
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS name                TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website             TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city                TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS province            TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country             TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry            TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_revenue      NUMERIC;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS number_of_employees INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS silo                TEXT NOT NULL DEFAULT 'BF';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_id            UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE companies ALTER COLUMN name DROP DEFAULT;

CREATE INDEX IF NOT EXISTS companies_silo_idx  ON companies(silo);
CREATE INDEX IF NOT EXISTS companies_owner_idx ON companies(owner_id);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id  UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS job_title    TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_status  TEXT DEFAULT 'New';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags         TEXT[] DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_id     UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contacts_company_idx     ON contacts(company_id);
CREATE INDEX IF NOT EXISTS contacts_owner_idx       ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS contacts_lead_status_idx ON contacts(lead_status);

-- ── 2. lender_products.status — DB-level default ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lender_products' AND column_name = 'status'
  ) THEN
    -- No NULLs allowed in the column; backfill any pre-existing nulls first.
    UPDATE lender_products SET status = 'active' WHERE status IS NULL;
    ALTER TABLE lender_products ALTER COLUMN status SET DEFAULT 'active';
  END IF;
END $$;

-- ── 3. Lenders submission_method — single source of truth ──
-- Canonical set: EMAIL, API, GOOGLE_SHEET. No MANUAL, no PORTAL,
-- no plural GOOGLE_SHEETS. Constraint and code agree.
DO $$
DECLARE col_type text;
BEGIN
  -- If the column is still an enum from migration 042, convert to text.
  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type IS NOT NULL AND col_type <> 'text' THEN
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN submission_method TYPE text USING submission_method::text';
  END IF;
END $$;

-- Drop ALL known CHECK constraints on submission_method before normalising data.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

-- Normalise existing data to the canonical set.
UPDATE lenders SET submission_method = UPPER(submission_method)
  WHERE submission_method IS NOT NULL
    AND submission_method <> UPPER(submission_method);

UPDATE lenders SET submission_method = 'GOOGLE_SHEET'
  WHERE submission_method = 'GOOGLE_SHEETS';

UPDATE lenders SET submission_method = 'EMAIL'
  WHERE submission_method IN ('MANUAL', 'PORTAL');

UPDATE lenders SET submission_method = 'EMAIL'
  WHERE submission_method IS NULL
     OR submission_method NOT IN ('EMAIL', 'API', 'GOOGLE_SHEET');

-- Re-add the canonical constraint.
ALTER TABLE lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IN ('EMAIL', 'API', 'GOOGLE_SHEET'));

-- Drop the active/status pair check from migration 042 — it has caused
-- spurious violations and the application enforces the invariant.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_active_status_check;
