-- BF_SERVER_v70_BLOCK_1_3 — companies.email + lookup index for CRM dedup.
-- The CRM mirror now treats company-email as the primary dedup key.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_email_lower_silo
  ON companies (silo, lower(coalesce(email, '')))
  WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS idx_companies_phone_silo
  ON companies (silo, phone)
  WHERE phone IS NOT NULL AND phone <> '';

CREATE INDEX IF NOT EXISTS idx_companies_name_lower_silo
  ON companies (silo, lower(trim(name)));
