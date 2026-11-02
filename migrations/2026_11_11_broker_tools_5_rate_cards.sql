-- BROKER_TOOLS_5_RATE_CARDS - lender rate cards (per lender product: term x amount band x credit tier -> rate or factor,
-- fees, residual options) and the deal structures staff build from them (side-by-side payment options). Idempotent.
-- BF_SERVER_v879_NO_PGCRYPTO - pgcrypto is not allow-listed on Azure Database for PostgreSQL; gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id uuid,
  lender_product_id text,
  lender_name text,
  name text NOT NULL,
  rate_kind text NOT NULL DEFAULT 'apr',
  active boolean NOT NULL DEFAULT true,
  effective_from date,
  min_amount numeric(14,2),
  max_amount numeric(14,2),
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  residual_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE rate_cards ADD CONSTRAINT rate_cards_rate_kind_check CHECK (rate_kind IN ('apr','factor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS rate_cards_lender_idx ON rate_cards (lender_id, lender_product_id);

CREATE TABLE IF NOT EXISTS rate_card_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
  term_months integer NOT NULL,
  amount_min numeric(14,2) NOT NULL DEFAULT 0,
  amount_max numeric(14,2),
  tier text NOT NULL DEFAULT 'any',
  rate numeric(10,5) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rate_card_cells_uq ON rate_card_cells (card_id, term_months, amount_min, tier);

CREATE TABLE IF NOT EXISTS deal_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen jsonb,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_structures_application_idx ON deal_structures (application_id, created_at DESC);
