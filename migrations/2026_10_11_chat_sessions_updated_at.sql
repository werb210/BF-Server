-- BF_SERVER_CHAT_SESSIONS_UPDATED_AT_v1
-- chat_sessions has no updated_at in the live schema (migrations/000000_baseline.sql),
-- yet /api/ai/ai/escalate, /api/ai/ai/close and chat.repo updateSessionStatus all
-- set it, and GET /api/admin/chats sorts by it, so every one of them failed.
-- Adding the column is the one change that makes all of them correct.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
