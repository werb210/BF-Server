-- Re-enable pgcrypto for SSN encryption.
-- If this CREATE EXTENSION fails on the managed Postgres role, the migration will error
-- and the deploy will not promote. In that case, set BF_SSN_ENCRYPTION_FALLBACK=1 in env
-- and the Node code will use AES-256-GCM via crypto.createCipheriv instead — see Step 6.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'pgcrypto unavailable; SSN encryption will use Node-side fallback';
  END;
END $$;

-- Companies columns (all idempotent).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS dba_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_structure TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_street TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_state TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_zip TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_country TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS employee_count INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS estimated_annual_revenue NUMERIC(18,2);

CREATE INDEX IF NOT EXISTS idx_companies_legal_name ON companies (legal_name);
CREATE INDEX IF NOT EXISTS idx_companies_address_state ON companies (address_state);

-- Role enum for contacts. Use TEXT + CHECK (more portable than CREATE TYPE if a partial
-- enum already exists). If a real enum already exists, ALTER ADD VALUE the new ones.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'unknown';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'contacts_role_check' AND table_name = 'contacts'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_role_check
      CHECK (role IN ('applicant','partner','guarantor','other','unknown'))
      NOT VALID;
  END IF;
END $$;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_role_check;

-- Contacts columns.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ssn_encrypted BYTEA;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_street TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_state TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_zip TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_country TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ownership_percent NUMERIC(5,2);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_primary_applicant BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'contacts_company_id_fkey' AND table_name = 'contacts'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_role ON contacts (role);
CREATE INDEX IF NOT EXISTS idx_contacts_is_primary ON contacts (is_primary_applicant);

-- Application <-> contacts join table.
CREATE TABLE IF NOT EXISTS application_contacts (
  application_id UUID NOT NULL,
  contact_id     UUID NOT NULL,
  role           TEXT NOT NULL DEFAULT 'applicant'
    CHECK (role IN ('applicant','partner','guarantor','other')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (application_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS idx_application_contacts_app ON application_contacts (application_id);
CREATE INDEX IF NOT EXISTS idx_application_contacts_contact ON application_contacts (contact_id);
