-- 132_recovery_columns.sql
-- Adds columns that prior migrations were supposed to add but never
-- physically created in production (schema_migrations had them marked
-- applied via manual hotfix). Fully idempotent.

-- applications.silo — referenced by silo middleware, dashboard,
-- pipeline, and applications.routes but never added by any prior migration.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS silo TEXT NULL;

CREATE INDEX IF NOT EXISTS applications_silo_idx ON applications (silo);

UPDATE applications SET silo = 'BF' WHERE silo IS NULL;

-- contacts.company_name — referenced by /api/crm/contacts INSERT but
-- never added by any prior migration.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS company_name TEXT NULL;

-- client_issues — backing table for the new POST /api/client/issues
-- endpoint. Persists user-submitted issue reports from the client
-- wizard "Report an Issue" button.
CREATE TABLE IF NOT EXISTS client_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NULL,
  contact_phone   TEXT NULL,
  message         TEXT NOT NULL,
  screenshot_b64  TEXT NULL,
  user_agent      TEXT NULL,
  url             TEXT NULL,
  silo            TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_issues_created_at_idx
  ON client_issues (created_at DESC);
