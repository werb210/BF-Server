-- 107_idempotency_repair.sql
-- Idempotent repair for all failed migrations (011, 015, 018, 019, 024, 027,
-- 039/041/042, 043, 058, 059, 060, 086, 087, 088, 090, 091, 098, 102, 999).
-- Also fixes the portal Lenders API_ERROR caused by NULL status values.
-- Safe to re-run on every deployment startup.

-- ============================================================
-- FIX 011: users.status DEFAULT + system service-account user
-- Root cause: column DEFAULT is 'active' (lowercase) but
--   users_status_check requires 'ACTIVE' | 'INACTIVE'
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'status'
  ) THEN
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'ACTIVE';
  END IF;
END $$;

INSERT INTO users (id, email, password_hash, role, active, password_changed_at, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'client-submission@system.local',
  '$2a$10$w6mUovSd.4MYgYusN4uT0.oVpi9oyaylVv4QOM4bLIKO7iHuUWLZa',
  'Referrer',
  false,
  now(),
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- FIX 015: refresh_tokens view
-- Root cause: CREATE VIEW fails on re-run; needs OR REPLACE
-- ============================================================
CREATE OR REPLACE VIEW refresh_tokens AS
  SELECT id, user_id, token_hash, expires_at, revoked_at
  FROM auth_refresh_tokens;

-- ============================================================
-- FIX 018: ocr_results -> ocr_document_results rename
-- Root cause: RENAME has no guard; fails when already renamed
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'ocr_results' AND table_type = 'BASE TABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'ocr_document_results' AND table_type = 'BASE TABLE'
  ) THEN
    ALTER TABLE ocr_results RENAME TO ocr_document_results;
  END IF;
END $$;

-- ============================================================
-- FIX 019: users_phone_number_unique
-- Root cause: ADD CONSTRAINT with no existence check
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_number_unique'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_number_unique UNIQUE (phone_number);
  END IF;
END $$;

-- ============================================================
-- FIX 024: otp_verifications_status_check
-- Root cause: ADD CONSTRAINT with no existence check
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'otp_verifications'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_verifications_status_check'
  ) THEN
    ALTER TABLE otp_verifications
      ADD CONSTRAINT otp_verifications_status_check
      CHECK (status IN ('pending', 'approved', 'expired'));
  END IF;
END $$;

-- ============================================================
-- FIX 027: lenders_name_unique
-- Root cause: ADD CONSTRAINT with no existence check
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lenders_name_unique') THEN
    ALTER TABLE lenders ADD CONSTRAINT lenders_name_unique UNIQUE (name);
  END IF;
END $$;

-- ============================================================
-- FIX 039 / 041 / 042: lender status normalisation
-- Root cause: UPDATE SET status = 'ACTIVE' (text literal) against
--   a lender_status enum column — needs ::lender_status cast
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lenders' AND column_name = 'status'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'lenders' AND column_name = 'status'
        AND data_type = 'text'
    ) THEN
      UPDATE lenders
      SET status = CASE
        WHEN status IS NULL             THEN 'ACTIVE'
        WHEN LOWER(status) = 'inactive' THEN 'INACTIVE'
        ELSE 'ACTIVE'
      END
      WHERE status IS NULL OR status NOT IN ('ACTIVE', 'INACTIVE');
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'lenders' AND column_name = 'status'
        AND udt_name = 'lender_status'
    ) THEN
      UPDATE lenders
      SET status = CASE
        WHEN status IS NULL                    THEN 'ACTIVE'::lender_status
        WHEN LOWER(status::text) = 'inactive'  THEN 'INACTIVE'::lender_status
        ELSE 'ACTIVE'::lender_status
      END
      WHERE status IS NULL OR status::text NOT IN ('ACTIVE', 'INACTIVE');
    END IF;
  END IF;
END $$;

-- ============================================================
-- FIX 043: call_logs missing crm_contact_id
-- Root cause: table created by 104 without crm_contact_id;
--   CREATE TABLE IF NOT EXISTS silently skips, then index fails
-- ============================================================
-- call_logs columns and indexes handled by 108_call_logs_full_schema.sql
-- Nothing to do here — avoids indexing columns that may not yet exist.

-- ============================================================
-- FIX 086 / 087 / 088: job tables
-- Root cause 086: CREATE TABLE without IF NOT EXISTS
-- Root cause 087: ALTER COLUMN before ADD COLUMN
-- Root cause 088: credit_summary_jobs never created
-- ============================================================

CREATE TABLE IF NOT EXISTS document_processing_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  text        NOT NULL,
  document_id     uuid,
  status          text        NOT NULL DEFAULT 'pending',
  job_type        text        NOT NULL DEFAULT 'ocr',
  retry_count     integer     NOT NULL DEFAULT 0,
  last_retry_at   timestamptz,
  max_retries     integer     NOT NULL DEFAULT 3,
  started_at      timestamptz,
  error_message   text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS document_processing_jobs
  ADD COLUMN IF NOT EXISTS document_id    uuid,
  ADD COLUMN IF NOT EXISTS job_type       text        NOT NULL DEFAULT 'ocr',
  ADD COLUMN IF NOT EXISTS retry_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at  timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries    integer     NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS error_message  text,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS banking_analysis_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  retry_count     integer     NOT NULL DEFAULT 0,
  last_retry_at   timestamptz,
  max_retries     integer     NOT NULL DEFAULT 2,
  started_at      timestamptz,
  error_message   text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS banking_analysis_jobs
  ADD COLUMN IF NOT EXISTS retry_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at  timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries    integer     NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS error_message  text,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS credit_summary_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  retry_count     integer     NOT NULL DEFAULT 0,
  last_retry_at   timestamptz,
  max_retries     integer     NOT NULL DEFAULT 1,
  started_at      timestamptz,
  error_message   text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS credit_summary_jobs
  ADD COLUMN IF NOT EXISTS retry_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at  timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries    integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS error_message  text,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_status      ON document_processing_jobs (status);
CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_application  ON document_processing_jobs (application_id);
CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_status          ON banking_analysis_jobs (status);
CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_application     ON banking_analysis_jobs (application_id);
CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_status            ON credit_summary_jobs (status);
CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_application       ON credit_summary_jobs (application_id);

-- ============================================================
-- FIX 058: processing_job_history_view UNION type mismatch
-- Root cause: application_id uuid vs text across branches
-- ============================================================
CREATE OR REPLACE VIEW processing_job_history_view AS
SELECT
  id                               AS job_id,
  'ocr'::text                      AS job_type,
  application_id::text             AS application_id,
  document_id::text                AS document_id,
  NULL::text                       AS previous_status,
  status                           AS next_status,
  error_message,
  retry_count,
  last_retry_at,
  COALESCE(updated_at, created_at) AS occurred_at
FROM document_processing_jobs
UNION ALL
SELECT
  id                               AS job_id,
  'banking'::text                  AS job_type,
  application_id::text             AS application_id,
  NULL::text                       AS document_id,
  NULL::text                       AS previous_status,
  status                           AS next_status,
  error_message,
  retry_count,
  last_retry_at,
  COALESCE(updated_at, created_at) AS occurred_at
FROM banking_analysis_jobs
UNION ALL
SELECT
  id                               AS job_id,
  'credit_summary'::text           AS job_type,
  application_id::text             AS application_id,
  NULL::text                       AS document_id,
  NULL::text                       AS previous_status,
  status                           AS next_status,
  error_message,
  retry_count,
  last_retry_at,
  COALESCE(updated_at, created_at) AS occurred_at
FROM credit_summary_jobs;

CREATE OR REPLACE VIEW processing_job_history AS
SELECT * FROM processing_job_history_view;

-- ============================================================
-- FIX 059: application_stage_events.reason + rebuilt views
-- Root cause: cascades from 058
-- ============================================================
ALTER TABLE IF EXISTS application_stage_events
  ADD COLUMN IF NOT EXISTS reason text;

CREATE OR REPLACE VIEW application_pipeline_history_view AS
SELECT
  ase.application_id,
  ase.from_stage,
  ase.to_stage,
  ase.trigger,
  ase.triggered_by  AS actor_id,
  u.role            AS actor_role,
  CASE
    WHEN ase.triggered_by = 'system'  THEN 'system'
    WHEN u.role IN ('ADMIN', 'STAFF') THEN 'staff'
    ELSE 'system'
  END               AS actor_type,
  ase.created_at    AS occurred_at,
  ase.reason
FROM application_stage_events ase
LEFT JOIN users u ON u.id::text = ase.triggered_by;

CREATE OR REPLACE VIEW application_pipeline_history AS
SELECT * FROM application_pipeline_history_view;

-- ============================================================
-- FIX 060: issue_reports.status column missing
-- Root cause: table pre-existed without status column
-- ============================================================
ALTER TABLE IF EXISTS issue_reports
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_status_check') THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_status_check
      CHECK (status IN ('open', 'in_progress', 'resolved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_issue_reports_status ON issue_reports (status);

-- ============================================================
-- FIX 090: otp_codes without pgcrypto
-- Root cause: CREATE EXTENSION pgcrypto blocked on Azure
-- ============================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id         uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text      NOT NULL,
  code       text      NOT NULL,
  attempts   int                   DEFAULT 0,
  created_at timestamp NOT NULL    DEFAULT now(),
  expires_at timestamp NOT NULL,
  consumed   boolean               DEFAULT false
);

ALTER TABLE IF EXISTS otp_codes
  ALTER COLUMN id  SET DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS attempts  int     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consumed  boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes (phone);

-- ============================================================
-- FIX 091: crm_timeline_events FK type mismatch
-- Root cause: application_id declared uuid but applications.id is text
-- ============================================================
CREATE TABLE IF NOT EXISTS crm_timeline_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id     uuid        NOT NULL REFERENCES contacts (id)     ON DELETE CASCADE,
  application_id text        NULL     REFERENCES applications (id) ON DELETE SET NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL DEFAULT '{}',
  actor_user_id  uuid        NULL     REFERENCES users (id)        ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_timeline_contact_idx     ON crm_timeline_events (contact_id,     created_at DESC);
CREATE INDEX IF NOT EXISTS crm_timeline_application_idx ON crm_timeline_events (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_timeline_event_type_idx  ON crm_timeline_events (event_type);

-- ============================================================
-- FIX 098: communications_messages.application_id type mismatch
-- Root cause: applications.id is text, not uuid
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'communications_messages_application_id_fkey'
  ) THEN
    ALTER TABLE communications_messages
      DROP CONSTRAINT communications_messages_application_id_fkey;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'communications_messages'
      AND column_name = 'application_id'
      AND data_type   = 'uuid'
  ) THEN
    ALTER TABLE communications_messages DROP COLUMN application_id;
  END IF;
END $$;

ALTER TABLE IF EXISTS communications_messages
  ADD COLUMN IF NOT EXISTS application_id text REFERENCES applications (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_name     text;

CREATE INDEX IF NOT EXISTS idx_comm_messages_application_id
  ON communications_messages (application_id);

-- ============================================================
-- FIX 102 + Lenders API_ERROR
-- Root cause 102: UPDATE to uppercase runs BEFORE DROP CONSTRAINT,
--   so the still-live lowercase constraint from 050 rejects it.
-- Root cause API_ERROR: lenders.repo.ts buildSelectColumns returns
--   the raw lender_status enum column with no COALESCE, so rows
--   seeded by 104 (status = NULL) reach the frontend as null and
--   crash the Lenders page render.
--
-- Fix: DROP constraint first, then uppercase, then add new constraint,
--   then fill any NULL status values.
-- ============================================================

-- Step 1: cast enum -> text if migration 041 ran on a prior deploy
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'lenders'
      AND column_name = 'submission_method'
      AND udt_name    = 'lender_submission_method'
  ) THEN
    ALTER TABLE lenders
      ALTER COLUMN submission_method TYPE text USING submission_method::text;
  END IF;
END $$;

-- Step 2: drop the old constraint (must happen before the UPDATE)
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

-- Step 3: normalise to uppercase
UPDATE lenders
SET submission_method = UPPER(submission_method)
WHERE submission_method IS NOT NULL
  AND submission_method <> UPPER(submission_method);

-- Step 4: add expanded constraint
ALTER TABLE lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (
    submission_method IS NULL
    OR submission_method IN ('EMAIL', 'API', 'GOOGLE_SHEET', 'GOOGLE_SHEETS', 'MANUAL')
  );

-- Step 5: fix NULL lender status (root cause of portal Lenders API_ERROR).
-- lenders.repo.ts returns the raw status column; the portal crashes on null.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lenders' AND column_name = 'status'
      AND udt_name = 'lender_status'
  ) THEN
    UPDATE lenders
    SET status = 'ACTIVE'::lender_status
    WHERE status IS NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lenders' AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    UPDATE lenders
    SET status = 'ACTIVE'
    WHERE status IS NULL OR status NOT IN ('ACTIVE', 'INACTIVE');
  END IF;
END $$;

-- ============================================================
-- FIX 999: idx_ocr_results_status on missing column
-- Root cause: ocr_results never had a status column
-- ============================================================
ALTER TABLE IF EXISTS ocr_results
  ADD COLUMN IF NOT EXISTS status text;

CREATE INDEX IF NOT EXISTS idx_ocr_results_status ON ocr_results (status);
