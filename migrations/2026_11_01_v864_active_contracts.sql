-- BF_SERVER_v864_ACTIVE_CONTRACTS - Active Contracts: every funded facility kept as a contract on the CRM company,
-- with renewal rules per lender product, a renewal engine, Boreal compensation tracking and an immutable ledger.
-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE / guarded, so running it twice changes nothing.

CREATE TABLE IF NOT EXISTS active_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  company_id uuid,
  contact_id uuid,
  application_id text,
  offer_id uuid,
  lender_id uuid,
  lender_product_id text,
  lender_name text,
  product_name text,
  product_category text,
  facility_type text,
  owner_user_id uuid,
  original_amount numeric(14,2),
  currency text NOT NULL DEFAULT 'CAD',
  funded_at date,
  term_months integer,
  maturity_date date,
  interest_rate numeric(8,4),
  factor_rate numeric(8,4),
  payment_amount numeric(14,2),
  payment_frequency text,
  status text NOT NULL DEFAULT 'active',
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  outcome_required boolean NOT NULL DEFAULT false,
  renewal_rule jsonb,
  renewal_eligible_on date,
  manual_renewal_eligible boolean NOT NULL DEFAULT false,
  residual_amount numeric(14,2),
  buyout_option text,
  buyout_price numeric(14,2),
  end_of_term_date date,
  commission_model text,
  commission_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  internal_notes text,
  previous_contract_id uuid,
  renewal_opportunity_id uuid,
  source text NOT NULL DEFAULT 'funded_application',
  original_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS active_contracts_application_uq ON active_contracts (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS active_contracts_company_idx ON active_contracts (company_id);
CREATE INDEX IF NOT EXISTS active_contracts_contact_idx ON active_contracts (contact_id);
CREATE INDEX IF NOT EXISTS active_contracts_silo_status_idx ON active_contracts (silo, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'active_contracts_status_check') THEN
    ALTER TABLE active_contracts ADD CONSTRAINT active_contracts_status_check CHECK (status IN (
      'active','renewal_upcoming','renewal_eligible','renewal_in_progress','refinanced','paid_out','matured','closed','default'));
  END IF;
END $$;

-- Renewal rules live on the lender product (one row per product).
CREATE TABLE IF NOT EXISTS lender_product_renewal_rules (
  lender_product_id text PRIMARY KEY,
  rule_type text NOT NULL,
  percent_threshold numeric(6,2),
  approach_points numeric(6,2) NOT NULL DEFAULT 10,
  months_before_maturity integer,
  eligible_after_months integer,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lender_product_renewal_rules_type_check CHECK (rule_type IN ('percent_paid','months_before_maturity','specific_date','manual','not_renewable'))
);

-- Renewal opportunities: a NEW deal linked to the contract; the original contract is never overwritten.
CREATE TABLE IF NOT EXISTS active_contract_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  silo text NOT NULL DEFAULT 'BF',
  kind text NOT NULL DEFAULT 'renewal',
  status text NOT NULL DEFAULT 'open',
  application_id text,
  new_contract_id uuid,
  reason text,
  owner_user_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT active_contract_opportunities_kind_check CHECK (kind IN ('renewal','refinance','additional')),
  CONSTRAINT active_contract_opportunities_status_check CHECK (status IN ('open','contacted','application_started','funded','lost','not_interested'))
);
CREATE UNIQUE INDEX IF NOT EXISTS active_contract_opportunities_open_uq ON active_contract_opportunities (contract_id)
  WHERE status IN ('open','contacted','application_started');
CREATE INDEX IF NOT EXISTS active_contract_opportunities_app_idx ON active_contract_opportunities (application_id);

-- Which engine milestones have fired (so each fires once).
CREATE TABLE IF NOT EXISTS active_contract_milestones (
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  milestone text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  detail text,
  PRIMARY KEY (contract_id, milestone)
);

-- Files on a contract: lender statements, insurance certificates, commission statements, the contract itself.
CREATE TABLE IF NOT EXISTS active_contract_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  kind text NOT NULL DEFAULT 'other',
  filename text NOT NULL,
  content_type text,
  size_bytes bigint,
  blob_name text NOT NULL,
  source text NOT NULL DEFAULT 'upload',
  contact_document_id uuid,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS active_contract_documents_contract_idx ON active_contract_documents (contract_id);

-- Balances: the latest confirmed one wins over the amortization estimate. Never edited, only added to.
CREATE TABLE IF NOT EXISTS active_contract_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  balance numeric(14,2) NOT NULL,
  as_of date NOT NULL,
  source text NOT NULL,
  payments_made integer,
  arrears numeric(14,2),
  note text,
  document_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT active_contract_balances_source_check CHECK (source IN ('lender_statement','lender_portal','manual','payoff'))
);
CREATE INDEX IF NOT EXISTS active_contract_balances_contract_idx ON active_contract_balances (contract_id, as_of DESC, created_at DESC);

-- Statements read by OCR/AI wait here until staff confirm them; nothing overwrites a balance on its own.
CREATE TABLE IF NOT EXISTS active_contract_statement_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  contract_id uuid REFERENCES active_contracts(id),
  document_id uuid,
  contact_document_id uuid,
  filename text,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  error text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  balance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT active_contract_statement_reviews_status_check CHECK (status IN ('pending','confirmed','rejected','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS active_contract_statement_reviews_cdoc_uq ON active_contract_statement_reviews (contact_document_id) WHERE contact_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS active_contract_statement_reviews_status_idx ON active_contract_statement_reviews (silo, status);

-- Expected compensation schedule. Expected is never revenue: only a ledger receipt is.
CREATE TABLE IF NOT EXISTS active_contract_expected_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  kind text NOT NULL,
  due_on date NOT NULL,
  period_label text,
  expected_amount numeric(14,2) NOT NULL,
  waived boolean NOT NULL DEFAULT false,
  variance_reviewed_at timestamptz,
  variance_reviewed_by uuid,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS active_contract_expected_payments_contract_idx ON active_contract_expected_payments (contract_id, due_on);

-- The contract ledger. Immutable: corrections are new rows (corrects_entry_id), never edits or deletes.
CREATE TABLE IF NOT EXISTS active_contract_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  entry_type text NOT NULL,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CAD',
  is_revenue boolean NOT NULL DEFAULT false,
  broker_split_amount numeric(14,2) NOT NULL DEFAULT 0,
  referral_split_amount numeric(14,2) NOT NULL DEFAULT 0,
  effective_on date NOT NULL DEFAULT CURRENT_DATE,
  period_label text,
  expected_payment_id uuid,
  document_id uuid,
  corrects_entry_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT active_contract_ledger_type_check CHECK (entry_type IN ('funding','commission_received','recurring_payment',
    'profit_share_payment','adjustment','clawback','renewal','refinance','payoff','maturity','closure','correction'))
);
CREATE INDEX IF NOT EXISTS active_contract_ledger_contract_idx ON active_contract_ledger (contract_id, created_at);
CREATE INDEX IF NOT EXISTS active_contract_ledger_expected_idx ON active_contract_ledger (expected_payment_id);

CREATE OR REPLACE FUNCTION active_contract_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'active_contract_ledger is append-only: add a correction entry instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS active_contract_ledger_no_change ON active_contract_ledger;
CREATE TRIGGER active_contract_ledger_no_change BEFORE UPDATE OR DELETE ON active_contract_ledger
  FOR EACH ROW EXECUTE FUNCTION active_contract_ledger_immutable();
DROP TRIGGER IF EXISTS active_contract_balances_no_change ON active_contract_balances;
CREATE TRIGGER active_contract_balances_no_change BEFORE UPDATE OR DELETE ON active_contract_balances
  FOR EACH ROW EXECUTE FUNCTION active_contract_ledger_immutable();

-- Equipment on a contract.
CREATE TABLE IF NOT EXISTS active_contract_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  description text NOT NULL,
  year integer,
  make text,
  model text,
  serial_number text,
  vendor text,
  cost numeric(14,2),
  location text,
  removed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS active_contract_assets_contract_idx ON active_contract_assets (contract_id);

-- Insurance certificates on a contract; the engine makes reminder tasks before they expire.
CREATE TABLE IF NOT EXISTS active_contract_insurance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES active_contracts(id),
  insurer text NOT NULL,
  policy_number text,
  coverage text,
  expires_on date,
  document_id uuid,
  replaced_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS active_contract_insurance_contract_idx ON active_contract_insurance (contract_id);

-- Per-silo automation settings. Everything automatic that reaches a client is OFF until an Admin turns it on.
CREATE TABLE IF NOT EXISTS active_contract_settings (
  silo text PRIMARY KEY,
  auto_email boolean NOT NULL DEFAULT false,
  auto_sms boolean NOT NULL DEFAULT false,
  email_subject text,
  email_body text,
  sms_body text,
  no_contact_months integer NOT NULL DEFAULT 6,
  client_portal boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
