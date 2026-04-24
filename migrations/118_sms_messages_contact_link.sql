-- Ensure communications_messages table has contact_id and SMS metadata fields.
-- Table name is based on migration 079 and the /api/messages routes.
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'outbound';
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS from_number TEXT;
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS to_number TEXT;
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF';

CREATE INDEX IF NOT EXISTS communications_messages_contact_idx ON communications_messages(contact_id);
CREATE INDEX IF NOT EXISTS communications_messages_silo_idx ON communications_messages(silo);
CREATE INDEX IF NOT EXISTS communications_messages_created_idx ON communications_messages(created_at DESC);
