-- BROKER_TOOLS_2_INVOICE_READING - vendor invoices read by the AI (vendor, invoice number, date, line items, subtotal,
-- taxes, total, equipment with serial / VIN). Each reading is a draft until staff confirm it; confirming fills the
-- deal's equipment fields and, when the file has an Active Contract, its equipment assets. Idempotent.
-- BF_SERVER_v879_NO_PGCRYPTO - pgcrypto is not allow-listed on Azure Database for PostgreSQL; gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS vendor_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  document_id text,
  file_name text,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL DEFAULT 'ai',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb,
  model text,
  read_error text,
  applied jsonb,
  assets_contract_id uuid,
  created_by uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE vendor_invoices ADD CONSTRAINT vendor_invoices_status_check CHECK (status IN ('draft','confirmed','discarded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS vendor_invoices_application_idx ON vendor_invoices (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_invoices_unsynced_idx ON vendor_invoices (status) WHERE status = 'confirmed' AND assets_contract_id IS NULL;
