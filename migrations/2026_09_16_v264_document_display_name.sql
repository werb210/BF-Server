-- BF_SERVER_RENAME_ON_ACCEPT_v264
-- Staff-chosen name set when a document is accepted. The applicant's original
-- filename stays in documents.filename for audit; the stored file is untouched.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS display_name text;
