-- BROKER_TOOLS_9_VENDOR_PORTAL - equipment vendors / dealers as partners: their profile and fee terms (the login is a
-- users row with role Referrer and partner_kind 'vendor', like the broker portal), the point-of-sale quotes they make
-- from the rate cards, and the vendor fees owed on funded deals they sent. Idempotent.
-- BF_SERVER_v879_NO_PGCRYPTO - pgcrypto is not allow-listed on Azure Database for PostgreSQL; gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS vendor_profiles (
  user_id uuid PRIMARY KEY,
  silo text NOT NULL DEFAULT 'BF',
  company_name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  province text,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'invited',
  fee_pct numeric(6,3),
  fee_flat numeric(14,2),
  fee_terms text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_profiles_code_uq ON vendor_profiles (lower(code));
DO $$ BEGIN
  ALTER TABLE vendor_profiles ADD CONSTRAINT vendor_profiles_status_check CHECK (status IN ('invited','pending_agreement','active','paused'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vendor_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL,
  customer_name text,
  customer_email text,
  customer_phone text,
  equipment_description text,
  amount numeric(14,2) NOT NULL,
  province text,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_quotes_vendor_idx ON vendor_quotes (vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL,
  application_id text NOT NULL,
  basis_amount numeric(14,2),
  fee_amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'expected',
  paid_on date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_fees_deal_uq ON vendor_fees (vendor_id, application_id);
DO $$ BEGIN
  ALTER TABLE vendor_fees ADD CONSTRAINT vendor_fees_status_check CHECK (status IN ('expected','paid','void'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
