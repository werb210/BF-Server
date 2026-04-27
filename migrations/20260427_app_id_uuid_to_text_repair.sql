-- BF_APP_ID_UUID_TO_TEXT_v39 — Block 39-C (replaces failed 38-A)
-- applications.id is text. Many later migrations declared application_id as
-- uuid, causing "operator does not exist: text = uuid" 500s anywhere SQL or
-- a view JOINs the column to applications.id. Convert every offending column
-- to text. The previous attempt aborted because two views pin the column
-- type — drop them before ALTER, recreate after.
-- Fully idempotent.

-- ── 1) Drop dependent views (will be recreated below). ──────────────────────
DROP VIEW IF EXISTS processing_job_history          CASCADE;
DROP VIEW IF EXISTS processing_job_history_view     CASCADE;

-- ── 2) Convert every uuid application_id column to text. ───────────────────
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('application_id','converted_application_id')
      AND c.data_type = 'uuid'
      AND c.table_name <> 'applications'
  LOOP
    -- Drop FK if present.
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      rec.table_schema, rec.table_name,
      rec.table_name || '_' || rec.column_name || '_fkey'
    );
    -- Convert uuid -> text.
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE text USING %I::text',
      rec.table_schema, rec.table_name, rec.column_name, rec.column_name
    );
    -- Restore the FK only for application_id (not converted_application_id —
    -- those tables may legitimately not have an FK).
    IF rec.column_name = 'application_id' THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I.%I
             ADD CONSTRAINT %I
             FOREIGN KEY (%I) REFERENCES applications(id) ON DELETE SET NULL',
          rec.table_schema, rec.table_name,
          rec.table_name || '_' || rec.column_name || '_fkey',
          rec.column_name
        );
      EXCEPTION WHEN OTHERS THEN
        -- Some tables had NOT NULL on application_id; leave the FK off in
        -- that case rather than abort. Type mismatch is the urgent fix.
        RAISE NOTICE 'Skipped FK on %.% — %', rec.table_name, rec.column_name, SQLERRM;
      END;
    END IF;
    RAISE NOTICE 'Converted %.%.% from uuid to text', rec.table_schema, rec.table_name, rec.column_name;
  END LOOP;
END $$;

-- ── 3) Recreate the views (verbatim from migration 110/201, but using the
--       now-text application_id columns directly — the ::text casts in the
--       view definitions are still valid no-ops). ─────────────────────────
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

CREATE OR REPLACE VIEW processing_job_history AS
SELECT * FROM processing_job_history_view;

-- ── 4) Indexes that may have been built on the old uuid column. ────────────
CREATE INDEX IF NOT EXISTS idx_comm_messages_application_id
  ON communications_messages(application_id);
