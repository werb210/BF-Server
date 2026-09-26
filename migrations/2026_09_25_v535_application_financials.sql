-- BF_SERVER_BLOCK_v535_FINANCIAL_EXTRACTION - financial statement / T2 figures
-- per application, period and line item, with the source document. Idempotent.
CREATE TABLE IF NOT EXISTS application_financials (
  id bigserial PRIMARY KEY,
  application_id text NOT NULL,
  period text NOT NULL,
  period_end date,
  kind text NOT NULL DEFAULT 'annual',
  line_item text NOT NULL,
  value numeric NOT NULL,
  source_document_id text,
  extracted_by text NOT NULL DEFAULT 'ai',
  edited_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS application_financials_cell_uq ON application_financials (application_id, period, line_item);
CREATE INDEX IF NOT EXISTS application_financials_app_idx ON application_financials (application_id);
