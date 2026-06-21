-- Adds applications.signnow_document_id (text). Referenced by the embedded
-- signing-session UPDATE, the legacy send path, loadPackageInputs, and the
-- SignNow webhook matcher (routes/signnow.ts). Stores the SignNow
-- document-group id. Idempotent — safe to re-run.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signnow_document_id text;
CREATE INDEX IF NOT EXISTS idx_applications_signnow_document_id ON applications (signnow_document_id);
