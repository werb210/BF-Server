-- BF_SERVER_BLOCK_v304_COMPANIES_REGION_COLUMN_v1
-- Two code paths address the company's state/province in different column
-- names:
--   * src/routes/crm.ts (POST/PATCH /api/crm/companies/*)  -> writes "region"
--   * src/routes/companies.ts (PATCH /api/companies/:id)   -> writes "province"
--   * src/services/applicationCrmMirror.ts                  -> writes "province"
-- The portal's CRM company edit modal (CompanyDetailPage.tsx) sends "region"
-- and hits the crm.ts handler. The companies table only has "province" — so
-- POST /api/crm/companies and the portal's company-edit save both 500 with
-- "column region of relation companies does not exist".
--
-- Minimum-disruption fix: add a nullable "region" column and one-time
-- backfill from "province". This unblocks the portal flow without changing
-- semantics in the other code paths. The duplication between province and
-- region is logged as an audit finding for later consolidation.

ALTER TABLE IF EXISTS companies
  ADD COLUMN IF NOT EXISTS region text;

-- One-shot backfill: copy province into region where region is still empty
-- and province has a value. Both columns are kept usable so existing
-- province-writing code paths continue to work.
UPDATE companies
   SET region = province
 WHERE (region IS NULL OR region = '')
   AND province IS NOT NULL
   AND province <> '';

CREATE INDEX IF NOT EXISTS companies_region_idx ON companies(region);
