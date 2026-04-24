-- 113_issues_table.sql
CREATE TABLE IF NOT EXISTS issues (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text,
  description    text,
  screenshot_url text,
  contact_id     uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  application_id text        REFERENCES applications(id) ON DELETE SET NULL,
  status         text        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','in_progress','resolved')),
  submitted_by   text,
  metadata       jsonb       NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_issues_status     ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_contact    ON issues(contact_id);
CREATE INDEX IF NOT EXISTS idx_issues_created    ON issues(created_at DESC);
