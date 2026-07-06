-- BF_SERVER_RETIRE_CRM_TASKS_v1 - retire the legacy crm_tasks table by copying
-- its rows into the unified `tasks` table, so nothing is lost when the old
-- /api/crm/contacts/:id/tasks route and the crm_tasks timeline branch are
-- removed. Idempotent: each migrated row records its origin crm_tasks.id in
-- tasks.source_ref_id with source='IMPORT', and we skip any crm_tasks row that
-- already has a matching tasks row. crm_tasks rows with no assignee AND no owner
-- cannot satisfy tasks.assignee_user_id (NOT NULL) and are left in place (the
-- table is not dropped, only retired from the app), so no data is destroyed.
INSERT INTO tasks (
  id, silo, title, body, type, status, priority, due_at, reminder_at,
  assignee_user_id, contact_id, company_id, created_by, source, source_ref_id,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  COALESCE(NULLIF(ct.silo, ''), 'BF'),
  COALESCE(NULLIF(ct.title, ''), 'Task'),
  ct.notes,
  CASE upper(COALESCE(ct.task_type, 'TODO'))
    WHEN 'CALL' THEN 'CALL' WHEN 'EMAIL' THEN 'EMAIL' WHEN 'SMS' THEN 'SMS'
    ELSE 'TODO' END,
  CASE lower(COALESCE(ct.status, 'open'))
    WHEN 'done' THEN 'COMPLETED' WHEN 'completed' THEN 'COMPLETED'
    WHEN 'in_progress' THEN 'IN_PROGRESS' WHEN 'waiting' THEN 'WAITING'
    WHEN 'deferred' THEN 'DEFERRED' ELSE 'NOT_STARTED' END,
  CASE upper(COALESCE(ct.priority, 'NONE'))
    WHEN 'LOW' THEN 'LOW' WHEN 'MEDIUM' THEN 'MEDIUM' WHEN 'HIGH' THEN 'HIGH'
    ELSE 'NONE' END,
  ct.due_at,
  ct.reminder_at,
  COALESCE(ct.assigned_to, ct.owner_id),
  ct.contact_id,
  ct.company_id,
  ct.owner_id,
  'IMPORT',
  ct.id,
  ct.created_at,
  ct.updated_at
FROM crm_tasks ct
WHERE COALESCE(ct.assigned_to, ct.owner_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.source = 'IMPORT' AND t.source_ref_id = ct.id
  );
