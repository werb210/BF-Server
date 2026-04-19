-- Ensure silo column exists and is indexed (102 failed, so it may be missing)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF';

CREATE INDEX IF NOT EXISTS contacts_silo_idx ON contacts(silo);
