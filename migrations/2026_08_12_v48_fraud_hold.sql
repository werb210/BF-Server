-- BF_SERVER_FRAUD_HOLD_v48
-- Fraud and Hold park an application without deleting related records.
-- The previous stage supports restoring the application to its former position.
-- This deliberately leaves the legacy pipeline_state CHECK unchanged because
-- existing title-case values do not match the uppercase list from migration 039.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS parked_previous_stage TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS parked_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS parked_by TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS parked_reason TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_confirmed_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_confirmed_by TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_applications_parked_stage
  ON applications(silo, pipeline_state)
  WHERE pipeline_state IN ('Fraud', 'Hold');
