-- 110_schema_completion.sql
-- Fixes: lenders.updated_at null (POST /api/portal/lenders 500),
--        058 view column rename conflict, 087 view-blocks-alter conflict,
--        missing lender_products columns, all remaining schema gaps.

-- ── Fix lenders timestamps (root cause of POST 500) ──────────────────────────
-- Migration 026 created these columns with NOT NULL but no DEFAULT.
-- 030 tried ADD COLUMN IF NOT EXISTS — silently skipped since they existed.
ALTER TABLE IF EXISTS lenders
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- Back-fill any existing nulls
UPDATE lenders SET created_at = now() WHERE created_at IS NULL;
UPDATE lenders SET updated_at = now() WHERE updated_at IS NULL;

-- ── Fix lender_products timestamps ───────────────────────────────────────────
ALTER TABLE IF EXISTS lender_products
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

UPDATE lender_products SET created_at = now() WHERE created_at IS NULL;
UPDATE lender_products SET updated_at = now() WHERE updated_at IS NULL;

-- ── lender_products missing columns (flagged in runtime log) ─────────────────
ALTER TABLE IF EXISTS lender_products
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS interest_min      text,
  ADD COLUMN IF NOT EXISTS interest_max      text,
  ADD COLUMN IF NOT EXISTS term_min          integer,
  ADD COLUMN IF NOT EXISTS term_max          integer,
  ADD COLUMN IF NOT EXISTS term_unit         text NOT NULL DEFAULT 'MONTHS',
  ADD COLUMN IF NOT EXISTS eligibility_notes text,
  ADD COLUMN IF NOT EXISTS signnow_template_id text;

-- Back-fill category from old type column
UPDATE lender_products
SET category = CASE
  WHEN UPPER(COALESCE(type, 'LOC')) IN ('LOC','LINE_OF_CREDIT','STANDARD') THEN 'LOC'
  WHEN UPPER(COALESCE(type, '')) IN ('TERM','TERM_LOAN')                   THEN 'TERM'
  WHEN UPPER(COALESCE(type, '')) = 'FACTORING'                             THEN 'FACTORING'
  WHEN UPPER(COALESCE(type, '')) IN ('PO','PURCHASE_ORDER')                THEN 'PO'
  WHEN UPPER(COALESCE(type, '')) IN ('EQUIPMENT','EQUIPMENT_FINANCING')    THEN 'EQUIPMENT'
  WHEN UPPER(COALESCE(type, '')) IN ('MCA','MERCHANT_CASH_ADVANCE')        THEN 'MCA'
  ELSE 'LOC'
END
WHERE category IS NULL;

ALTER TABLE IF EXISTS lender_products
  ALTER COLUMN category SET NOT NULL,
  ALTER COLUMN category SET DEFAULT 'LOC';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lender_products_category_check') THEN
    ALTER TABLE lender_products ADD CONSTRAINT lender_products_category_check
      CHECK (category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA'));
  END IF;
END $$;

-- Back-fill rate columns from old names
UPDATE lender_products SET interest_min = COALESCE(interest_min, min_rate) WHERE interest_min IS NULL;
UPDATE lender_products SET interest_max = COALESCE(interest_max, max_rate) WHERE interest_max IS NULL;

-- ── lenders missing columns ───────────────────────────────────────────────────
ALTER TABLE IF EXISTS lenders
  ADD COLUMN IF NOT EXISTS primary_contact_name  text,
  ADD COLUMN IF NOT EXISTS primary_contact_email text,
  ADD COLUMN IF NOT EXISTS primary_contact_phone text,
  ADD COLUMN IF NOT EXISTS api_config            jsonb,
  ADD COLUMN IF NOT EXISTS internal_notes        text,
  ADD COLUMN IF NOT EXISTS description           text;

-- Back-fill from old contact_* columns if they exist
UPDATE lenders SET primary_contact_name  = COALESCE(primary_contact_name,  contact_name)  WHERE primary_contact_name IS NULL;
UPDATE lenders SET primary_contact_email = COALESCE(primary_contact_email, contact_email) WHERE primary_contact_email IS NULL;
UPDATE lenders SET primary_contact_phone = COALESCE(primary_contact_phone, contact_phone) WHERE primary_contact_phone IS NULL;

-- ── Fix submission_method constraint (102 root cause) ────────────────────────
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;
UPDATE lenders SET submission_method = UPPER(submission_method)
  WHERE submission_method IS NOT NULL AND submission_method <> UPPER(submission_method);
ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IS NULL
    OR submission_method IN ('EMAIL','API','GOOGLE_SHEET','GOOGLE_SHEETS','MANUAL'));

-- ── users / contacts silo and profile columns (102 fix) ──────────────────────
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS first_name            text,
  ADD COLUMN IF NOT EXISTS last_name             text,
  ADD COLUMN IF NOT EXISTS silo                  text,
  ADD COLUMN IF NOT EXISTS last_login_at         timestamptz,
  ADD COLUMN IF NOT EXISTS o365_user_email       text,
  ADD COLUMN IF NOT EXISTS o365_access_token     text,
  ADD COLUMN IF NOT EXISTS o365_token_expires_at timestamptz;

-- ── users.status default and system user (011) ───────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'status') THEN
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'ACTIVE';
    UPDATE users SET status = 'ACTIVE'   WHERE status = 'active';
    UPDATE users SET status = 'INACTIVE' WHERE status IN ('inactive','disabled');
  END IF;
END $$;

INSERT INTO users (id, email, password_hash, role, active, password_changed_at, status)
VALUES ('00000000-0000-0000-0000-000000000001','client-submission@system.local',
        '$2a$10$w6mUovSd.4MYgYusN4uT0.oVpi9oyaylVv4QOM4bLIKO7iHuUWLZa','Referrer',false,now(),'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- ── refresh_tokens view (015) ────────────────────────────────────────────────
CREATE OR REPLACE VIEW refresh_tokens AS
  SELECT id, user_id, token_hash, expires_at, revoked_at FROM auth_refresh_tokens;

-- ── otp_codes without pgcrypto (090) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text NOT NULL, code text NOT NULL,
  attempts int DEFAULT 0, created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL, consumed boolean DEFAULT false
);
ALTER TABLE IF EXISTS otp_codes
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS attempts int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consumed boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);

-- ── crm_timeline_events with TEXT application_id FK (091) ────────────────────
CREATE TABLE IF NOT EXISTS crm_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  application_id text NULL REFERENCES applications(id) ON DELETE SET NULL,
  event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_timeline_contact_idx     ON crm_timeline_events(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_timeline_application_idx ON crm_timeline_events(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_timeline_event_type_idx  ON crm_timeline_events(event_type);

-- ── communications_messages.application_id as TEXT FK (098) ──────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_name = 'communications_messages_application_id_fkey') THEN
    ALTER TABLE communications_messages DROP CONSTRAINT communications_messages_application_id_fkey;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'communications_messages' AND column_name = 'application_id'
               AND data_type = 'uuid') THEN
    ALTER TABLE communications_messages DROP COLUMN application_id;
  END IF;
END $$;
ALTER TABLE IF EXISTS communications_messages
  ADD COLUMN IF NOT EXISTS application_id text REFERENCES applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_name     text;
CREATE INDEX IF NOT EXISTS idx_comm_messages_application_id ON communications_messages(application_id);

-- ── ocr_results.status (999) ─────────────────────────────────────────────────
ALTER TABLE IF EXISTS ocr_results ADD COLUMN IF NOT EXISTS status text;
CREATE INDEX IF NOT EXISTS idx_ocr_results_status ON ocr_results(status);

-- ── application_stage_events.reason (059) ────────────────────────────────────
ALTER TABLE IF EXISTS application_stage_events ADD COLUMN IF NOT EXISTS reason text;

-- ── Drop conflicting views before recreating (fixes 058 "cannot rename column"
--    and 087 "cannot alter column used by view") ──────────────────────────────
DROP VIEW IF EXISTS processing_job_history CASCADE;
DROP VIEW IF EXISTS processing_job_history_view CASCADE;
DROP VIEW IF EXISTS document_status_history CASCADE;
DROP VIEW IF EXISTS document_status_history_view CASCADE;
DROP VIEW IF EXISTS application_pipeline_history CASCADE;
DROP VIEW IF EXISTS application_pipeline_history_view CASCADE;

-- ── job tables (086-088) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id text NOT NULL,
  document_id uuid, status text NOT NULL DEFAULT 'pending',
  job_type text NOT NULL DEFAULT 'ocr', retry_count integer NOT NULL DEFAULT 0,
  last_retry_at timestamptz, max_retries integer NOT NULL DEFAULT 3,
  started_at timestamptz, error_message text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS document_processing_jobs
  ADD COLUMN IF NOT EXISTS document_id   uuid,
  ADD COLUMN IF NOT EXISTS job_type      text NOT NULL DEFAULT 'ocr',
  ADD COLUMN IF NOT EXISTS retry_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries   integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS banking_analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending', retry_count integer NOT NULL DEFAULT 0,
  last_retry_at timestamptz, max_retries integer NOT NULL DEFAULT 2,
  started_at timestamptz, error_message text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS banking_analysis_jobs
  ADD COLUMN IF NOT EXISTS retry_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries   integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS credit_summary_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending', retry_count integer NOT NULL DEFAULT 0,
  last_retry_at timestamptz, max_retries integer NOT NULL DEFAULT 1,
  started_at timestamptz, error_message text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS credit_summary_jobs
  ADD COLUMN IF NOT EXISTS retry_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_retries   integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_dpj_status ON document_processing_jobs(status);
CREATE INDEX IF NOT EXISTS idx_dpj_app    ON document_processing_jobs(application_id);
CREATE INDEX IF NOT EXISTS idx_baj_status ON banking_analysis_jobs(status);
CREATE INDEX IF NOT EXISTS idx_baj_app    ON banking_analysis_jobs(application_id);
CREATE INDEX IF NOT EXISTS idx_csj_status ON credit_summary_jobs(status);
CREATE INDEX IF NOT EXISTS idx_csj_app    ON credit_summary_jobs(application_id);

-- ── Recreate views (type-safe, consistent column names) ──────────────────────
CREATE OR REPLACE VIEW processing_job_history_view AS
SELECT id AS job_id, 'ocr'::text AS job_type, application_id::text,
       document_id::text, NULL::text AS previous_status, status AS next_status,
       error_message, retry_count, last_retry_at,
       COALESCE(updated_at, created_at) AS occurred_at
FROM document_processing_jobs
UNION ALL
SELECT id, 'banking'::text, application_id::text, NULL::text,
       NULL::text, status, error_message, retry_count, last_retry_at,
       COALESCE(updated_at, created_at)
FROM banking_analysis_jobs
UNION ALL
SELECT id, 'credit_summary'::text, application_id::text, NULL::text,
       NULL::text, status, error_message, retry_count, last_retry_at,
       COALESCE(updated_at, created_at)
FROM credit_summary_jobs;

CREATE OR REPLACE VIEW processing_job_history AS SELECT * FROM processing_job_history_view;

CREATE OR REPLACE VIEW application_pipeline_history_view AS
SELECT ase.application_id, ase.from_stage, ase.to_stage, ase.trigger,
       ase.triggered_by AS actor_id, u.role AS actor_role,
       CASE WHEN ase.triggered_by = 'system' THEN 'system'
            WHEN u.role IN ('ADMIN','STAFF') THEN 'staff' ELSE 'system' END AS actor_type,
       ase.created_at AS occurred_at, ase.reason
FROM application_stage_events ase
LEFT JOIN users u ON u.id::text = ase.triggered_by;

CREATE OR REPLACE VIEW application_pipeline_history AS SELECT * FROM application_pipeline_history_view;

-- ── issue_reports.status (060) ───────────────────────────────────────────────
ALTER TABLE IF EXISTS issue_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_status_check') THEN
    ALTER TABLE issue_reports ADD CONSTRAINT issue_reports_status_check
      CHECK (status IN ('open','in_progress','resolved'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_issue_reports_status ON issue_reports(status);
