-- BF_SERVER_v942_DEAL_CLOSE_REVENUE (Todd and Andrew, Nov 11 2026)
-- deal_closes: the Close tab - what actually funded. One per application (a renewal is a new application).
-- deal_revenue_lines: every way the brokerage is paid on the deal, expected then received:
--   lender_commission (flat or % of funded), residual (a month of profit share), client_fee, setup_fee, proceeds_fee,
--   spread (our rate vs the lender's), other; and referral_fee (money out: owed to the referral partner).
-- Brokers are paid on revenue the brokerage has received (Todd: "when the brokerage gets paid").
CREATE TABLE IF NOT EXISTS deal_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL UNIQUE,
  offer_id text,
  closed_on date NOT NULL,
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
  funded_amount numeric(14,2) NOT NULL,
  rate text,
  term_months integer,
  payment_frequency text,
  lender_id uuid,
  lender_name text,
  lender_product_id text,
  broker_user_id uuid,
  lead_source text NOT NULL DEFAULT 'company' CHECK (lead_source IN ('self', 'company')),
  clawback_days integer,
  residual_percent numeric(7,3),
  residual_months integer,
  renewal_of_application_id text,
  status text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'clawed_back')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_closes_broker_idx ON deal_closes (broker_user_id, closed_on);

CREATE TABLE IF NOT EXISTS deal_revenue_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_id uuid NOT NULL REFERENCES deal_closes(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('lender_commission', 'residual', 'client_fee', 'setup_fee', 'proceeds_fee', 'spread', 'referral_fee', 'other')),
  description text,
  basis text NOT NULL DEFAULT 'flat' CHECK (basis IN ('flat', 'percent')),
  percent numeric(9,4),
  expected_amount numeric(14,2),
  month date,
  due_on date,
  received_amount numeric(14,2),
  received_on date,
  clawed_back_on date,
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'received', 'clawed_back', 'written_off')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_revenue_lines_close_idx ON deal_revenue_lines (close_id);
CREATE INDEX IF NOT EXISTS deal_revenue_lines_received_idx ON deal_revenue_lines (received_on) WHERE status = 'received';

-- Broker pay (Settings > Broker pay, owner only).
CREATE TABLE IF NOT EXISTS brokerage_pay_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  schedule text NOT NULL DEFAULT 'semi_monthly' CHECK (schedule IN ('semi_monthly', 'monthly', 'on_receipt')),
  tier_basis text NOT NULL DEFAULT 'revenue' CHECK (tier_basis IN ('revenue', 'funded_volume')),
  tier_mode text NOT NULL DEFAULT 'marginal' CHECK (tier_mode IN ('marginal', 'whole')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO brokerage_pay_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS broker_pay_plans (
  user_id uuid PRIMARY KEY,
  split_company_pct numeric(6,3) NOT NULL DEFAULT 0,
  split_self_pct numeric(6,3) NOT NULL DEFAULT 0,
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,          -- [{ "from": 0, "pct": 40 }, { "from": 50000, "pct": 50 }]
  residual_share boolean NOT NULL DEFAULT true,       -- their book of business, while they work here
  base_monthly numeric(12,2) NOT NULL DEFAULT 0,
  draw_monthly numeric(12,2) NOT NULL DEFAULT 0,      -- advanced each period, recovered from commission
  manager_user_id uuid,
  override_pct numeric(6,3) NOT NULL DEFAULT 0,       -- the manager's share of this broker's split revenue
  active boolean NOT NULL DEFAULT true,
  starts_on date NOT NULL DEFAULT CURRENT_DATE,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_bonus_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('per_deal', 'volume_target', 'revenue_target')),
  amount numeric(12,2) NOT NULL,
  threshold numeric(14,2),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_pay_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  pay_date date NOT NULL,
  amount numeric(12,2) NOT NULL,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broker_pay_adjustments_user_idx ON broker_pay_adjustments (user_id, pay_date);
