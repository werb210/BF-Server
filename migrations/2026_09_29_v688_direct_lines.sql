-- BF_SERVER_DIRECT_LINES_v688 - staff direct phone numbers; companies.tags (the companies search
-- and tag filter read co.tags, which never existed, so any company search returned a 500).
ALTER TABLE users ADD COLUMN IF NOT EXISTS direct_number text;
CREATE UNIQUE INDEX IF NOT EXISTS users_direct_number_uniq ON users (direct_number) WHERE direct_number IS NOT NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
