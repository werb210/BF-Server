-- BF_SERVER_v70_BLOCK_1_1 — orchestrator state.
-- application_lender_selections: which lenders staff chose (separate from
--   lender_submissions which is the per-attempt log).
-- application_packages: tracks each (app, lender) ZIP build + send.

CREATE TABLE IF NOT EXISTS application_lender_selections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  TEXT NOT NULL,
  lender_id       UUID NOT NULL,
  selected_by     TEXT,
  selected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (application_id, lender_id)
);
CREATE INDEX IF NOT EXISTS idx_app_lender_selections_app
  ON application_lender_selections(application_id);

CREATE TABLE IF NOT EXISTS application_packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  TEXT NOT NULL,
  lender_id       UUID NOT NULL,
  blob_name       TEXT,
  blob_url        TEXT,
  size_bytes      BIGINT,
  status          TEXT NOT NULL DEFAULT 'pending',
  failure_reason  TEXT,
  built_at        TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_application_packages_app
  ON application_packages(application_id);

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS signnow_app_document_id     TEXT;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS signnow_app_signed_at       TIMESTAMPTZ;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS submission_chain_started_at TIMESTAMPTZ;
