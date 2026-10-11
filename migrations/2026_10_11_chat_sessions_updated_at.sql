-- BF_SERVER_v784_CHAT_SCHEMA - /ai/escalate and /ai/close set updated_at, chat.repo.ts reads it and
-- GET /api/admin/chats sorts by it, but the live chat_sessions table never had the column.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
