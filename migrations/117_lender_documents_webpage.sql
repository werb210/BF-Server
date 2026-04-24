-- Add webpage to lenders
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS webpage TEXT;

-- Lender documents for Maya knowledge
CREATE TABLE IF NOT EXISTS lender_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id UUID NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  blob_url TEXT NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lender_docs_lender_idx ON lender_documents(lender_id);
