-- BF_SERVER_BLOCK_v536_COLLATERAL_EXTRACTION - structured agings, equipment and
-- real-estate schedules per application, one row per source document. Idempotent.
CREATE TABLE IF NOT EXISTS application_collateral (
  id bigserial PRIMARY KEY,
  application_id text NOT NULL,
  kind text NOT NULL,
  source_document_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted_by text NOT NULL DEFAULT 'ai',
  edited_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS application_collateral_doc_uq ON application_collateral (application_id, source_document_id);
CREATE INDEX IF NOT EXISTS application_collateral_app_idx ON application_collateral (application_id);
