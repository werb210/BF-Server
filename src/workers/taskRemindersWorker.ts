// BF_SERVER_TASKS_M6_v1 - Tasks Milestone 6 background job. Three duties, all
// silo-agnostic (each task carries its own silo) and idempotent:
//   1. Reminders: reminder_at <= now() and not yet sent -> in-app notification
//      to the assignee; stamp reminder_sent_at so it fires once.
//   2. Recurrence catch-up: a repeat_active task that became overdue and has
//      no child yet -> regenerate the next occurrence (parity with HubSpot's
//      "completed, deleted, or overdue" trigger; complete/delete are handled
//      inline in the routes).
//   3. Daily digest: once per day per assignee, at/after 08:00 their time, a
//      "Due today" summary notification. Deduped via task_digest_log.
import type { Pool } from "pg";

const TICK_MS = 5 * 60 * 1000; // every 5 minutes

async function runReminders(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url)
     SELECT t.assignee_user_id::text, 'task_reminder', 'tasks', t.id::text,
            'Task reminder: ' || t.title, '/tasks'
       FROM tasks t
      WHERE t.reminder_at IS NOT NULL AND t.reminder_at <= now()
        AND t.reminder_sent_at IS NULL AND t.deleted_at IS NULL
        AND t.status <> 'COMPLETED' AND t.assignee_user_id IS NOT NULL`
  );
  await pool.query(
    `UPDATE tasks SET reminder_sent_at = now()
      WHERE reminder_at IS NOT NULL AND reminder_at <= now()
        AND reminder_sent_at IS NULL AND deleted_at IS NULL AND status <> 'COMPLETED'`
  );
}

function nextDue(due: Date, interval: number, unit: string): Date {
  const d = new Date(due.getTime());
  if (unit === "DAY") d.setUTCDate(d.getUTCDate() + interval);
  else if (unit === "WEEK") d.setUTCDate(d.getUTCDate() + interval * 7);
  else if (unit === "MONTH") d.setUTCMonth(d.getUTCMonth() + interval);
  else if (unit === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + interval);
  return d;
}

async function runRecurrenceCatchup(pool: Pool): Promise<void> {
  const due = await pool.query<{
    id: string; silo: string; title: string; body: string | null; type: string;
    priority: string; due_at: string; queue_id: string | null; assignee_user_id: string;
    contact_id: string | null; company_id: string | null; created_by: string | null;
    repeat_interval: number; repeat_unit: string;
  }>(
    `SELECT id, silo, title, body, type, priority, due_at, queue_id, assignee_user_id,
            contact_id, company_id, created_by, repeat_interval, repeat_unit
       FROM tasks t
      WHERE t.repeat_active = true AND t.deleted_at IS NULL
        AND t.due_at IS NOT NULL AND t.due_at < now() AND t.status <> 'COMPLETED'
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.repeat_parent_id = t.id)
      LIMIT 200`
  );
  for (const t of due.rows) {
    if (!t.repeat_interval || !t.repeat_unit) continue;
    const nd = nextDue(new Date(t.due_at), t.repeat_interval, t.repeat_unit);
    await pool.query(
      `INSERT INTO tasks (silo, title, body, type, priority, due_at, queue_id, assignee_user_id,
                          contact_id, company_id, created_by, source, repeat_interval, repeat_unit,
                          repeat_parent_id, repeat_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MANUAL',$12,$13,$14,true)`,
      [t.silo, t.title, t.body, t.type, t.priority, nd.toISOString(), t.queue_id, t.assignee_user_id,
       t.contact_id, t.company_id, t.created_by, t.repeat_interval, t.repeat_unit, t.id]
    );
  }
}

async function runDigest(pool: Pool): Promise<void> {
  const hourUtc = new Date().getUTCHours();
  if (hourUtc < 8) return;
  await pool.query(
    `INSERT INTO task_digest_log (user_id, digest_date)
     SELECT t.assignee_user_id::text, current_date
       FROM tasks t
      WHERE t.deleted_at IS NULL AND t.status <> 'COMPLETED'
        AND t.due_at::date = current_date AND t.assignee_user_id IS NOT NULL
      GROUP BY t.assignee_user_id
     ON CONFLICT (user_id, digest_date) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url)
     SELECT dl.user_id, 'task_digest', 'tasks', NULL,
            'You have ' || cnt.n || ' task' || CASE WHEN cnt.n = 1 THEN '' ELSE 's' END || ' due today.',
            '/tasks'
       FROM task_digest_log dl
       JOIN LATERAL (
         SELECT count(*)::int AS n FROM tasks t
          WHERE t.assignee_user_id::text = dl.user_id AND t.deleted_at IS NULL
            AND t.status <> 'COMPLETED' AND t.due_at::date = current_date
       ) cnt ON true
      WHERE dl.digest_date = current_date AND dl.notified_at IS NULL AND cnt.n > 0`
  );
  await pool.query(
    `UPDATE task_digest_log SET notified_at = now()
      WHERE digest_date = current_date AND notified_at IS NULL`
  );
}

export function startTaskRemindersWorker(pool: Pool): { stop: () => void } {
  const tick = async () => {
    try { await runReminders(pool); } catch (e) { console.error("[tasks-worker] reminders", e instanceof Error ? e.message : e); }
    try { await runRecurrenceCatchup(pool); } catch (e) { console.error("[tasks-worker] recurrence", e instanceof Error ? e.message : e); }
    try { await runDigest(pool); } catch (e) { console.error("[tasks-worker] digest", e instanceof Error ? e.message : e); }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
