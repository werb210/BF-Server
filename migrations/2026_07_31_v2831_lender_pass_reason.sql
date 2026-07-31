-- BF_SERVER_LENDER_PASS_REASON_v1
CREATE TABLE IF NOT EXISTS application_lender_responses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL,
  lender_id      TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  outcome        TEXT NOT NULL DEFAULT 'declined',
  reason         TEXT NOT NULL DEFAULT '',
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, lender_id)
);

CREATE INDEX IF NOT EXISTS idx_application_lender_responses_app
  ON application_lender_responses (application_id);
