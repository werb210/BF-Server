-- BF_SERVER_BI_DOC_COPY_v701 - when a document was copied to its linked BI (PGI) application.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS bi_mirrored_at timestamptz;
