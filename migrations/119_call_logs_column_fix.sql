-- Fix missing phone_number column that crashes call log queries
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS call_logs_contact_idx ON call_logs(contact_id);
