-- BF_SERVER_AUTO_TAMPER_SCAN_v269
-- Results of the tamper scan that now runs automatically on every uploaded
-- document (and still on demand from the portal). Signals are explainable hints
-- for staff, never a verdict: nothing is auto-rejected.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tamper_level text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tamper_signals jsonb;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tamper_scanned_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_documents_tamper_unscanned ON documents (created_at) WHERE tamper_scanned_at IS NULL;
