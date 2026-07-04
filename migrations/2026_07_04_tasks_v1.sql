-- BF_SERVER_TASKS_V1 - HubSpot-style Tasks + queues (spec: HubSpot Tasks &
-- Queue Runner build spec, Milestone 1). Silo-scoped (BF/BI/SLF). TEXT +
-- CHECK instead of enums so re-runs stay idempotent.
CREATE TABLE IF NOT EXISTS task_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL CHECK (silo IN ('BF','BI','SLF')),
  name text NOT NULL,
  access_type text NOT NULL DEFAULT 'PRIVATE' CHECK (access_type IN ('PRIVATE','SHARED')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_queues_silo ON task_queues(silo);

CREATE TABLE IF NOT EXISTS task_queue_shares (
  queue_id uuid NOT NULL REFERENCES task_queues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  silo text NOT NULL CHECK (silo IN ('BF','BI','SLF')),
  PRIMARY KEY (queue_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL CHECK (silo IN ('BF','BI','SLF')),
  title text NOT NULL,
  body text,
  type text NOT NULL DEFAULT 'TODO' CHECK (type IN ('CALL','EMAIL','SMS','TODO')),
  status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','WAITING','COMPLETED','DEFERRED')),
  priority text NOT NULL DEFAULT 'NONE' CHECK (priority IN ('NONE','LOW','MEDIUM','HIGH')),
  due_at timestamptz,
  reminder_at timestamptz,
  queue_id uuid REFERENCES task_queues(id) ON DELETE SET NULL,
  assignee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  repeat_interval int,
  repeat_unit text CHECK (repeat_unit IS NULL OR repeat_unit IN ('DAY','WEEK','MONTH','YEAR')),
  repeat_parent_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  repeat_active boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','SEQUENCE','WORKFLOW','IMPORT','API')),
  source_ref_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_silo_status_due ON tasks(silo, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
