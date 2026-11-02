-- BROKER_TOOLS_1_FUNDING_CONDITIONS - the funding conditions checklist between Accepted and Funded.
-- Templates per lender / lender product (blank = every deal), and one checklist row per condition on an application.
-- A file can move to Funded only when every condition is cleared or waived (an Admin may override with a reason,
-- which is written to the audit log). Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS funding_condition_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id uuid,
  lender_product_id text,
  title text NOT NULL,
  description text,
  owner text NOT NULL DEFAULT 'staff',
  due_days integer,
  requires_document boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE funding_condition_templates ADD CONSTRAINT funding_condition_templates_owner_check CHECK (owner IN ('staff','client','lender'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS funding_condition_templates_lender_idx ON funding_condition_templates (lender_id, lender_product_id);

CREATE TABLE IF NOT EXISTS funding_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  title text NOT NULL,
  description text,
  owner text NOT NULL DEFAULT 'staff',
  assigned_user_id uuid,
  due_date date,
  status text NOT NULL DEFAULT 'open',
  source text NOT NULL DEFAULT 'manual',
  template_id uuid,
  offer_id text,
  requires_document boolean NOT NULL DEFAULT false,
  document_id text,
  document_url text,
  note text,
  waived_reason text,
  cleared_at timestamptz,
  cleared_by uuid,
  waived_at timestamptz,
  waived_by uuid,
  client_submitted_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE funding_conditions ADD CONSTRAINT funding_conditions_owner_check CHECK (owner IN ('staff','client','lender'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE funding_conditions ADD CONSTRAINT funding_conditions_status_check CHECK (status IN ('open','received','cleared','waived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE funding_conditions ADD CONSTRAINT funding_conditions_source_check CHECK (source IN ('manual','template','offer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS funding_conditions_application_idx ON funding_conditions (application_id);
-- One row per template per application, so "add from templates" can run again safely.
CREATE UNIQUE INDEX IF NOT EXISTS funding_conditions_template_once ON funding_conditions (application_id, template_id) WHERE template_id IS NOT NULL;
