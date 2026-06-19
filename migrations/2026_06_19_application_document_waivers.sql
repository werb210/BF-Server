-- BF_SERVER_DOC_WAIVERS_v1 — per-application admin document waivers.
CREATE TABLE IF NOT EXISTS application_document_waivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  text NOT NULL,
  document_type   text NOT NULL,
  waived_by       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_doc_waiver
  ON application_document_waivers (application_id, document_type);
