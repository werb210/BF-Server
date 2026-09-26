-- BF_SERVER_BLOCK_v538_CREDIT_SUMMARY_V2 - the new credit write-up per
-- application: draft while staff work on it, submitted once signed. Idempotent.
CREATE TABLE IF NOT EXISTS credit_summaries_v2 (
  application_id text PRIMARY KEY,
  doc jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  submitted_by_id text,
  submitted_by_name text,
  submitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
