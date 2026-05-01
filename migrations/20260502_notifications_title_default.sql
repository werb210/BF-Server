-- BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — defensive backfill + DEFAULT.
-- Idempotent. Safe to re-run.

-- Backfill any NULL titles (shouldn't exist if NOT NULL was enforced, but
-- some prior migration may have allowed nulls before tightening).
UPDATE notifications SET title = COALESCE(NULLIF(type, ''), 'Notification') WHERE title IS NULL;

-- Add a server-side DEFAULT so an INSERT without an explicit title still
-- satisfies the NOT NULL constraint. The application code path also
-- supplies a title; this DEFAULT exists strictly as a safety net.
ALTER TABLE notifications ALTER COLUMN title SET DEFAULT 'Notification';
