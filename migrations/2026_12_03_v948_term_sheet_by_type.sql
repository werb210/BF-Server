-- BF_SERVER_v948_TERM_SHEET_BY_TYPE - one term sheet template per type of financing, plus a general one
-- (financing_type NULL) used when a type has no template of its own.
ALTER TABLE licensee_documents ADD COLUMN IF NOT EXISTS financing_type text;
DROP INDEX IF EXISTS licensee_documents_one_active_kind;
CREATE UNIQUE INDEX IF NOT EXISTS licensee_documents_one_active_kind_type
  ON licensee_documents (kind, COALESCE(financing_type, '')) WHERE active AND kind <> 'other';
