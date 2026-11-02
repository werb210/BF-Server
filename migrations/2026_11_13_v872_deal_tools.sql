-- BF_SERVER_v872_DEAL_TOOLS - batch 5: quotes, the commission forecast, ID verification and payment links for broker
-- fees (ported from KS-server #50 and #47 without Keystone's plan gates). Idempotent: safe to run on every start.

-- 1. Quotes -----------------------------------------------------------------------------------------------------------
-- Staff build a quote for the client from one or more lender offers on a file. The client views it in the client app
-- and accepts one option (typed name + tick, recorded with the time and a hashed IP) or declines. Accepting an option
-- that came from an offer stages that offer exactly like the offer's own Accept button, so the staff "Confirm
-- acceptance" step and the lender e-signing that follows are unchanged. Sales tax on fees uses the v865 sales-tax
-- helper: each fee has its own "taxable" tick and the quote carries the province whose rate applies (the business's
-- province by default).
CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  quote_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text NOT NULL DEFAULT 'Your financing options',
  message text,
  currency text NOT NULL DEFAULT 'CAD',
  tax_province text,
  expires_on date,
  pdf_document_id text,
  accepted_option_id uuid,
  accepted_name text,
  accepted_ip_hash text,
  accepted_user_agent text,
  decline_reason text,
  view_count integer NOT NULL DEFAULT 0,
  created_by text,
  sent_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  withdrawn_at timestamptz,
  CONSTRAINT quotes_status_check CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn')),
  CONSTRAINT quotes_currency_check CHECK (currency IN ('CAD', 'USD'))
);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_province text;
CREATE INDEX IF NOT EXISTS quotes_application_idx ON quotes (application_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_number_uq ON quotes (quote_number);

CREATE TABLE IF NOT EXISTS quote_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  offer_id text,
  lender_name text NOT NULL,
  product_name text,
  amount numeric(14, 2) NOT NULL,
  term_months numeric(6, 2),
  rate_kind text NOT NULL DEFAULT 'interest_rate',
  rate numeric(10, 4),
  payment_frequency text NOT NULL DEFAULT 'monthly',
  payment_count integer,
  payment_amount numeric(14, 2),
  payment_overridden boolean NOT NULL DEFAULT false,
  -- [{ label, amount, deducted, taxable }]
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ label: "GST 5%", amount }] - the sales tax on the fees ticked taxable, at the quote's province rate.
  tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_tax numeric(14, 2) NOT NULL DEFAULT 0,
  total_fees numeric(14, 2) NOT NULL DEFAULT 0,
  total_repayment numeric(14, 2),
  cost_of_borrowing numeric(14, 2),
  net_proceeds numeric(14, 2),
  estimated_apr numeric(8, 2),
  recommended boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_options_rate_kind_check CHECK (rate_kind IN ('interest_rate', 'factor_rate')),
  CONSTRAINT quote_options_frequency_check CHECK (payment_frequency IN ('daily', 'weekly', 'biweekly', 'semimonthly', 'monthly'))
);
ALTER TABLE quote_options ADD COLUMN IF NOT EXISTS tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quote_options ADD COLUMN IF NOT EXISTS total_tax numeric(14, 2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS quote_options_quote_idx ON quote_options (quote_id, position);

-- What happened to a quote, for the staff timeline. No personal data in detail.
CREATE TABLE IF NOT EXISTS quote_events (
  id bigserial PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor text NOT NULL DEFAULT 'staff',
  user_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_events_quote_idx ON quote_events (quote_id, created_at);

-- 2. Forecast ---------------------------------------------------------------------------------------------------------
-- The chance each lending stage funds is batch 3's lending-pipeline probability (settings key
-- lending_pipeline_probabilities, Settings > Pipelines), and an extra pipeline's stage uses its own probability. Each
-- application gets an expected close date and an optional forecast category that overrides the one its chance implies.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS expected_close_date date;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS forecast_category text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_forecast_category_check') THEN
    ALTER TABLE applications ADD CONSTRAINT applications_forecast_category_check
      CHECK (forecast_category IS NULL OR forecast_category IN ('pipeline', 'best_case', 'commit', 'omit'));
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS applications_expected_close_idx ON applications (expected_close_date) WHERE expected_close_date IS NOT NULL;

-- 3. ID verification (KYC) --------------------------------------------------------------------------------------------
-- One row per verification request: who it is for, which provider runs it (onfido = Entrust IDV hosted document +
-- selfie liveness flow; manual = the applicant uploads ID and a selfie and staff decide), its status and the
-- non-personal reasons. What the vendor read from the ID (name, date of birth, document number, expiry) is kept only
-- encrypted (pii_enc, the same scheme as the SIN), never in plain columns or logs. ID images are stored as documents
-- on the application, so the retention and legal-hold rules cover them like any other upload.
CREATE TABLE IF NOT EXISTS kyc_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  -- NULL = automatic: onfido when it is set up on this server, else manual review.
  provider text,
  -- Show "Verify your identity" right after the client submits the application.
  wizard_step boolean NOT NULL DEFAULT false,
  wizard_people text NOT NULL DEFAULT 'applicant',
  updated_at timestamptz,
  updated_by text,
  CONSTRAINT kyc_settings_one_row CHECK (id = 1),
  CONSTRAINT kyc_settings_provider_check CHECK (provider IS NULL OR provider IN ('onfido', 'manual')),
  CONSTRAINT kyc_settings_people_check CHECK (wizard_people IN ('applicant', 'applicant_and_guarantors'))
);
INSERT INTO kyc_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS kyc_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  contact_id text,
  person_role text NOT NULL DEFAULT 'applicant',
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  decision_source text,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  vendor_applicant_id text,
  vendor_session_id text,
  session_url_enc bytea,
  session_expires_at timestamptz,
  pii_enc bytea,
  document_ids text[] NOT NULL DEFAULT '{}',
  requested_by text,
  requested_via text NOT NULL DEFAULT 'staff',
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_verifications_status_check
    CHECK (status IN ('requested', 'in_progress', 'processing', 'approved', 'declined', 'review', 'expired', 'cancelled', 'error'))
);
CREATE INDEX IF NOT EXISTS kyc_verifications_app_idx ON kyc_verifications (application_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS kyc_verifications_contact_idx ON kyc_verifications (contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_vendor_session_uq
  ON kyc_verifications (provider, vendor_session_id) WHERE vendor_session_id IS NOT NULL;

-- Webhook deliveries already handled (vendor retries are answered 200 without running twice).
CREATE TABLE IF NOT EXISTS kyc_webhook_events (
  provider text NOT NULL,
  event_key text NOT NULL,
  verification_id uuid,
  outcome text,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_key)
);

-- 4. Payment links (broker fees) --------------------------------------------------------------------------------------
-- A payment link is a Boreal URL that opens a Stripe Checkout page on Boreal's own Stripe account (card, or Canadian
-- pre-authorized debit - ACSS - in CAD). Stripe's webhook tells us when it is paid, processing or failed; a paid link
-- on an application with a QuickBooks fee invoice records a QuickBooks payment against that invoice.
CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  application_id text,
  contact_id uuid,
  silo text NOT NULL DEFAULT 'BF',
  description text NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'cad',
  methods text[] NOT NULL DEFAULT ARRAY['card', 'acss_debit']::text[],
  status text NOT NULL DEFAULT 'open',
  livemode boolean,
  checkout_session_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  checkout_count integer NOT NULL DEFAULT 0,
  payment_intent_id text,
  payment_method_type text,
  amount_received_cents integer,
  paid_at timestamptz,
  processing_at timestamptz,
  failed_at timestamptz,
  failure_message text,
  cancelled_at timestamptz,
  sent_channels text[] NOT NULL DEFAULT '{}'::text[],
  sent_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  quickbooks_status text NOT NULL DEFAULT 'none',
  quickbooks_payment_id text,
  quickbooks_error text,
  quickbooks_attempts integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_links_amount_check CHECK (amount_cents >= 50),
  CONSTRAINT payment_links_status_check CHECK (status IN ('open', 'processing', 'paid', 'failed', 'cancelled', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_token_uidx ON payment_links (token);
CREATE INDEX IF NOT EXISTS payment_links_application_idx ON payment_links (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_contact_idx ON payment_links (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_session_idx ON payment_links (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_links_qbo_due_idx ON payment_links (quickbooks_status) WHERE quickbooks_status IN ('pending', 'retrying');

-- Each Stripe event is handled once (Stripe retries deliveries).
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
