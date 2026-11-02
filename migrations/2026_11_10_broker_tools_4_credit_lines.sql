-- BROKER_TOOLS_4_CREDIT_LINES - approved credit lines per client: lender, limit, expiry and conditions; each draw
-- reduces what is available (a repayment restores it); reminder tasks before a line expires (once per expiry date).
-- Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS credit_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  company_id uuid,
  contact_id uuid,
  application_id text,
  lender_id uuid,
  lender_name text,
  product_name text,
  limit_amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  approved_on date,
  expiry_date date,
  conditions text,
  status text NOT NULL DEFAULT 'active',
  reminder_days integer NOT NULL DEFAULT 30,
  owner_user_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
DO $$ BEGIN
  ALTER TABLE credit_lines ADD CONSTRAINT credit_lines_status_check CHECK (status IN ('active','expired','closed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS credit_lines_company_idx ON credit_lines (company_id);
CREATE INDEX IF NOT EXISTS credit_lines_contact_idx ON credit_lines (contact_id);
CREATE INDEX IF NOT EXISTS credit_lines_expiry_idx ON credit_lines (status, expiry_date);

CREATE TABLE IF NOT EXISTS credit_line_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_line_id uuid NOT NULL REFERENCES credit_lines(id),
  application_id text,
  kind text NOT NULL DEFAULT 'draw',
  source text NOT NULL DEFAULT 'manual',
  amount numeric(14,2) NOT NULL,
  drawn_on date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversed_by uuid
);
DO $$ BEGIN
  ALTER TABLE credit_line_draws ADD CONSTRAINT credit_line_draws_kind_check CHECK (kind IN ('draw','repayment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS credit_line_draws_line_idx ON credit_line_draws (credit_line_id);
-- A funded file draws on its linked line once.
CREATE UNIQUE INDEX IF NOT EXISTS credit_line_draws_funded_uq ON credit_line_draws (credit_line_id, application_id)
  WHERE source = 'funded' AND reversed_at IS NULL;

CREATE TABLE IF NOT EXISTS credit_line_reminders (
  credit_line_id uuid NOT NULL REFERENCES credit_lines(id),
  expiry_date date NOT NULL,
  task_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credit_line_id, expiry_date)
);
