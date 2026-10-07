-- BF_SERVER_TODO_RECONCILE_v773 - when a task was last mirrored to Microsoft To Do.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS graph_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS tasks_graph_sync_pending_idx ON tasks (assignee_user_id) WHERE graph_synced_at IS NULL OR graph_id IS NOT NULL;
