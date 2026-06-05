-- BF_SERVER_BLOCK_v332_UNIFY_TASKS_v1 — unify tasks onto crm_tasks (idempotent).
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Copy any existing calendar_tasks into crm_tasks using the SAME id, so re-running is a
-- no-op and existing references by id keep working. calendar_tasks are not contact-linked.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'calendar_tasks') THEN
    INSERT INTO crm_tasks
      (id, title, notes, due_at, task_type, priority, status, completed_at,
       assigned_to, owner_id, contact_id, company_id, graph_id, silo, created_at, updated_at)
    SELECT ct.id, ct.title, ct.notes, ct.due_at, 'todo', ct.priority, ct.status, ct.completed_at,
           ct.assignee_user_id, ct.user_id, NULL, NULL, ct.o365_task_id, ct.silo, ct.created_at, ct.updated_at
    FROM calendar_tasks ct
    WHERE NOT EXISTS (SELECT 1 FROM crm_tasks t WHERE t.id = ct.id);
  END IF;
END $$;
