-- Renamed from 202602_continuation.sql into sequential numbering.
-- Original intent: application continuation flow persistence and lookup index.

CREATE TABLE IF NOT EXISTS application_continuations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(64) UNIQUE NOT NULL,
  company_name TEXT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  industry TEXT,
  years_in_business INTEGER,
  monthly_revenue NUMERIC,
  annual_revenue NUMERIC,
  ar_outstanding NUMERIC,
  existing_debt BOOLEAN,
  crm_lead_id UUID,
  converted_application_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  converted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_continuation_token
ON application_continuations(token);
