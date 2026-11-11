-- KS_SERVER_LICENSEE_DOCUMENTS - a licensee's own application form, client agreement, term sheet and other documents.
-- Their fields are matched to the data Keystone collects; fields with no match become extra wizard questions.
CREATE TABLE IF NOT EXISTS licensee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('application_form', 'client_agreement', 'term_sheet', 'other')),
  name text NOT NULL,
  file_name text,
  format text NOT NULL,
  file bytea NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS licensee_documents_one_active_kind
  ON licensee_documents (kind) WHERE active AND kind <> 'other';

CREATE TABLE IF NOT EXISTS licensee_wizard_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES licensee_documents(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'yesno', 'choice', 'date', 'number')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, key)
);

-- The lender's own term sheet is kept when the brokerage re-issues the offer on its own term sheet.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS lender_term_sheet_blob_name text;
