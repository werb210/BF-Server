-- Fix contacts.id having no default value
ALTER TABLE contacts
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Also ensure user_id column exists for owner tracking
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id);
