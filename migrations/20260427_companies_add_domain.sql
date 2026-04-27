-- BF_COMPANIES_DOMAIN_v26 — Block 26-A
-- Idempotent: the portal company edit modal posts a `domain` field, but the
-- companies table never had that column. Azure log:
--   ERROR: column "domain" of relation "companies" does not exist
--   at routes/crm.js:333 (PATCH /api/crm/companies/:id)
-- Add it. No data migration required; existing rows will have NULL domain.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS domain TEXT;

CREATE INDEX IF NOT EXISTS companies_domain_idx ON companies (domain);
