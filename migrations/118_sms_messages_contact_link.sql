-- Ensure messages table has contact_id and direction
ALTER TABLE messages ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_number TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_number TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF';
CREATE INDEX IF NOT EXISTS messages_contact_idx ON messages(contact_id);
CREATE INDEX IF NOT EXISTS messages_silo_idx ON messages(silo);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at DESC);
