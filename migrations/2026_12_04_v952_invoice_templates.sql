-- BF_SERVER_v952_INVOICE_TEMPLATES - a brokerage's own invoice layout, filled for a file's fee. Safe to run twice.
ALTER TABLE licensee_documents DROP CONSTRAINT IF EXISTS licensee_documents_kind_check;
ALTER TABLE licensee_documents ADD CONSTRAINT licensee_documents_kind_check
  CHECK (kind IN ('application_form', 'client_agreement', 'term_sheet', 'invoice', 'other'));
CREATE SEQUENCE IF NOT EXISTS client_invoice_number_seq START 1001;
CREATE TABLE IF NOT EXISTS client_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL,
  number text NOT NULL UNIQUE,
  description text NOT NULL,
  amount numeric(14,2) NOT NULL,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL,
  due_date date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_invoices_application_idx ON client_invoices (application_id, created_at DESC);
