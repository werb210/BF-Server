-- BROKER_TOOLS_7_SCORECARDS - the credit scorecard and pre-decision rules an Admin weights (one settings row), and the
-- last result on each application (score, grade, rule hits, lender ranking). Signals only: nothing is decided
-- automatically. Idempotent.
CREATE TABLE IF NOT EXISTS credit_scorecard_settings (
  id integer PRIMARY KEY DEFAULT 1,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE credit_scorecard_settings ADD CONSTRAINT credit_scorecard_settings_one_row CHECK (id = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS application_scorecards (
  application_id text PRIMARY KEY,
  score numeric(6,2),
  grade text,
  outcome text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_by uuid,
  computed_at timestamptz NOT NULL DEFAULT now()
);
