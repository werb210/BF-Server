-- BF_SERVER_BLOCK_v470_USERS_DELETED_AT_MIGRATION_v1
-- Block v221's admin users list query references users.deleted_at
-- for soft-delete exclusion. Column was never added; admin list
-- 500s on staff calendar attendee picker and any other surface that
-- hits /api/admin/users. Idempotent: IF NOT EXISTS so re-running
-- on a healthy DB is a no-op.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_users_active_not_deleted
  ON users(id) WHERE deleted_at IS NULL;
