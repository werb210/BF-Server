ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS silo text,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Populate name from email prefix where possible
UPDATE users
SET first_name = split_part(email, '@', 1)
WHERE first_name IS NULL AND email IS NOT NULL;
