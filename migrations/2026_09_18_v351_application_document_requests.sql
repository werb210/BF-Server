-- BF_SERVER_REQUESTED_DOCS_v351
-- Documents staff request from Request Items. Until now the request only posted a
-- chat message: the documents were never stored, so the staff checklist forgot
-- them and the client's upload task counted as finished (its button disappeared).
CREATE TABLE IF NOT EXISTS application_document_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  document_type text NOT NULL,
  requested_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS application_document_requests_app_type_uq
  ON application_document_requests (application_id, document_type);
