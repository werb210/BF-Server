-- BF_SERVER_v873_LENDER_API - lender API connections (ported from KS-server #53, no plan gate).
-- lender_connections      one per lender: which connector, its settings, encrypted credentials, status map
-- lender_api_submissions  one per (application, lender) sent by API: the lender's deal id, its status, retries, polling
-- lender_api_events       the submission log and status timeline (submit attempts, status changes, offers, conditions)
-- lender_api_conditions   conditions and document requests the lender reported
-- offers gain lender_external_id so a synced offer is updated, never duplicated. Safe to run again.
CREATE TABLE IF NOT EXISTS lender_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id uuid NOT NULL,
  connector text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  submit_by_api boolean NOT NULL DEFAULT true,
  email_fallback boolean NOT NULL DEFAULT true,
  poll_enabled boolean NOT NULL DEFAULT true,
  poll_interval_minutes integer NOT NULL DEFAULT 30,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_encrypted text,
  secret_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lender_connections_lender_uq ON lender_connections (lender_id);

CREATE TABLE IF NOT EXISTS lender_api_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  lender_id uuid NOT NULL,
  connection_id uuid,
  connector text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  external_id text,
  linked_record_id text,
  lender_status text,
  lender_status_label text,
  bucket text,
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_error text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  funded_amount numeric(14,2),
  commission_amount numeric(14,2),
  submitted_by uuid,
  submitted_at timestamptz,
  last_synced_at timestamptz,
  next_poll_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lender_api_submissions_app_lender_uq ON lender_api_submissions (application_id, lender_id);
CREATE INDEX IF NOT EXISTS lender_api_submissions_external_idx ON lender_api_submissions (lender_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lender_api_submissions_linked_idx ON lender_api_submissions (lender_id, linked_record_id) WHERE linked_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lender_api_submissions_poll_idx ON lender_api_submissions (next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lender_api_submissions_retry_idx ON lender_api_submissions (next_retry_at) WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lender_api_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid,
  application_id text NOT NULL,
  lender_id uuid NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  status text,
  detail text,
  data jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lender_api_events_app_idx ON lender_api_events (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lender_api_events_lender_idx ON lender_api_events (lender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lender_api_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL,
  application_id text NOT NULL,
  lender_id uuid NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL DEFAULT 'condition',
  description text NOT NULL,
  document_type text,
  status text NOT NULL DEFAULT 'open',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lender_api_conditions_uq ON lender_api_conditions (submission_id, external_id);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS lender_external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS offers_lender_external_uq ON offers (lender_id, lender_external_id) WHERE lender_external_id IS NOT NULL;

-- Boreal follow-ups: a lender condition is copied once into the funding conditions checklist (v865) and linked here.
ALTER TABLE lender_api_conditions ADD COLUMN IF NOT EXISTS funding_condition_id uuid;
DO $$ BEGIN
  ALTER TABLE funding_conditions DROP CONSTRAINT IF EXISTS funding_conditions_source_check;
  ALTER TABLE funding_conditions ADD CONSTRAINT funding_conditions_source_check CHECK (source IN ('manual','template','offer','lender_api'));
EXCEPTION WHEN undefined_table THEN NULL; END $$;
