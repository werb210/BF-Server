-- BF_SERVER_NO_IMPORTS_IN_BF_v1 - imported lists are taken back out of the Boreal Financial CRM. Every record removed is
-- kept here first, so the clean-up can be undone.
CREATE TABLE IF NOT EXISTS bf_import_cleanup_backup (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  record_id uuid NOT NULL,
  record jsonb NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bf_import_cleanup_backup_record_idx ON bf_import_cleanup_backup (record_id);
CREATE TABLE IF NOT EXISTS bf_import_cleanup_runs (
  id bigserial PRIMARY KEY,
  result jsonb NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now()
);
