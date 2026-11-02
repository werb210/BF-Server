-- BROKER_TOOLS_8_CONTRACTS - contracts from Word (.docx) templates with merge fields: the templates, and each contract
-- made on a deal (filled .docx, PDF, signers, SignNow ids, signed PDF). Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS contract_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  file_name text,
  docx bytea NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  template_id uuid,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'generated',
  merge_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  docx bytea,
  pdf bytea,
  signed_pdf bytea,
  signers jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  signnow_document_id text,
  signnow_group_id text,
  sent_at timestamptz,
  signed_at timestamptz,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_status_check CHECK (status IN ('generated','sent','signed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS contract_documents_application_idx ON contract_documents (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contract_documents_sent_idx ON contract_documents (status, updated_at) WHERE status = 'sent';
