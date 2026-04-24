-- Users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

-- AI sessions
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Companies table
ALTER TABLE companies ADD COLUMN IF NOT EXISTS silo TEXT DEFAULT 'BF';
