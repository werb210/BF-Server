-- BF_SERVER_DOC_SHARING_v635 - a document copied from another of the client's applications
-- instead of asking the client to upload it again. One row per copy; the copy itself is an
-- ordinary documents row on the receiving application.
CREATE TABLE IF NOT EXISTS document_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_document_id text NOT NULL,
  target_application_id text NOT NULL,
  source_document_id text NOT NULL,
  source_application_id text NOT NULL,
  document_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_shares_target_kind_uq ON document_shares (target_application_id, document_kind);
CREATE INDEX IF NOT EXISTS document_shares_source_idx ON document_shares (source_document_id);
