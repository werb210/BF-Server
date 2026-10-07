// BF_SERVER_TODO_RECONCILE_v773
// Portal tasks -> each assignee's Microsoft To Do (Outlook, iPhone/Mac Reminders), and back.
// Before this, only tasks created or edited on the portal's task screen were mirrored. Tasks made by
// the abandoned-application worker, sequences, automations, calls, meetings, bookings and Maya never
// reached To Do; deleted and bulk-completed tasks stayed open there forever; ticking a task off in
// To Do changed nothing in the portal; and every Graph failure was swallowed without a log line.
// Every 5 minutes, per assignee with a Microsoft sign-in:
//   1. Push: open tasks never sent (graph_id and graph_synced_at both NULL) are created; tasks
//      changed since their last sync (updated_at > graph_synced_at) are updated, completed, or
//      deleted in To Do.
//   2. Pull: To Do tasks marked completed complete the matching open portal task.
// graph_synced_at = updated_at after each sync, so the pull never echoes back as a push.
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "../modules/o365/graphClient.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

const TICK_MS = 5 * 60 * 1000;
const MAX_USERS_PER_TICK = 50;
const MAX_TASKS_PER_USER = 100;
const ALBERTA_OFFSET_MS = 6 * 60 * 60 * 1000; // Alberta is UTC-6 all year

export type PendingTask = {
  id: string; title: string; body: string | null; status: string; priority: string;
  due_at: string | Date | null; reminder_at: string | Date | null; deleted_at: string | Date | null;
  graph_id: string | null; contact_id: string | null; contact_name: string | null;
};

class GraphError extends Error {
  constructor(public status: number, path: string) { super("graph_" + status + " " + path.split("?")[0]); }
}

async function call(graph: GraphClient, path: string, init?: RequestInit): Promise<any> {
  const resp = await graph.fetch(path, init);
  if (!resp.ok) throw new GraphError(resp.status, path);
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/** To Do keeps only a due DATE. BF_SERVER_TODO_DUE_DATE_v776 - send midnight of the Alberta calendar day in a
 *  fixed UTC-6 zone (Alberta is UTC-6 all year), the way Microsoft's own apps store it. Noon UTC (v773) was
 *  stored as midnight UTC, which iPhone/Mac Reminders showed as the day before. */
export function todoDueDate(due: string | Date): { dateTime: string; timeZone: string } {
  const local = new Date(new Date(due).getTime() - ALBERTA_OFFSET_MS);
  return { dateTime: local.toISOString().slice(0, 10) + "T00:00:00.0000000", timeZone: "Central America Standard Time" };
}

export function todoTitle(t: Pick<PendingTask, "title" | "contact_name">): string {
  const title = String(t.title ?? "").trim() || "Task";
  const who = String(t.contact_name ?? "").trim();
  return who && !title.toLowerCase().includes(who.toLowerCase()) ? title + " - " + who : title;
}

export function todoPayload(t: PendingTask, now = Date.now()): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: todoTitle(t),
    body: { content: String(t.body ?? ""), contentType: "text" },
    importance: String(t.priority).toUpperCase() === "HIGH" ? "high" : String(t.priority).toUpperCase() === "LOW" ? "low" : "normal",
    status: t.status === "COMPLETED" ? "completed" : "notStarted",
    dueDateTime: t.due_at ? todoDueDate(t.due_at) : null,
  };
  // Remind at the reminder time, or at the due time when that is still ahead.
  const remind = t.reminder_at ?? (t.due_at && new Date(t.due_at).getTime() > now ? t.due_at : null);
  if (remind && t.status !== "COMPLETED") {
    payload.isReminderOn = true;
    payload.reminderDateTime = { dateTime: new Date(remind).toISOString().replace("Z", ""), timeZone: "UTC" };
  } else {
    payload.isReminderOn = false;
  }
  return payload;
}

async function defaultListId(graph: GraphClient): Promise<string | null> {
  const lists = await call(graph, "/me/todo/lists?$top=50");
  const all: Array<{ id?: string; wellknownListName?: string }> = lists?.value ?? [];
  return (all.find((l) => l.wellknownListName === "defaultList") ?? all[0])?.id ?? null;
}

async function markSynced(pool: Pool, id: string, graphId: string | null): Promise<void> {
  await pool.query(`UPDATE tasks SET graph_id = $2, graph_synced_at = updated_at WHERE id = $1`, [id, graphId]);
}

async function pushUser(pool: Pool, graph: GraphClient, listId: string, userId: string, onlyTaskId: string | null = null): Promise<number> {
  const pending = await pool.query<PendingTask>(
    `SELECT t.id, t.title, t.body, t.status, t.priority, t.due_at, t.reminder_at, t.deleted_at, t.graph_id, t.contact_id,
            NULLIF(TRIM(COALESCE(NULLIF(c.name, ''), CONCAT_WS(' ', c.first_name, c.last_name))), '') AS contact_name
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.assignee_user_id = $1
        AND ((t.graph_id IS NULL AND t.graph_synced_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'COMPLETED')
          OR (t.graph_id IS NOT NULL AND (t.graph_synced_at IS NULL OR t.updated_at > t.graph_synced_at)))
        AND ($3::uuid IS NULL OR t.id = $3::uuid)
      ORDER BY t.updated_at ASC
      LIMIT $2`,
    [userId, MAX_TASKS_PER_USER, onlyTaskId],
  );
  let done = 0;
  for (const t of pending.rows) {
    const base = "/me/todo/lists/" + listId + "/tasks";
    try {
      if (t.deleted_at) {
        if (t.graph_id) {
          try { await call(graph, base + "/" + t.graph_id, { method: "DELETE" }); }
          catch (err) { if (!(err instanceof GraphError && err.status === 404)) throw err; }
        }
        await markSynced(pool, t.id, null);
      } else if (t.graph_id) {
        try {
          await call(graph, base + "/" + t.graph_id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(todoPayload(t)) });
          await markSynced(pool, t.id, t.graph_id);
        } catch (err) {
          // Deleted in To Do: leave the portal task alone and stop syncing it (graph_synced_at set, so it is not re-created).
          if (err instanceof GraphError && err.status === 404) await markSynced(pool, t.id, null);
          else throw err;
        }
      } else {
        const payload = todoPayload(t);
        if (t.contact_id) payload.linkedResources = [{ webUrl: "https://staff.boreal.financial/crm/contacts/" + t.contact_id, applicationName: "Boreal CRM", displayName: todoTitle(t) }];
        const created = await call(graph, base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        await markSynced(pool, t.id, (created as { id?: string } | null)?.id ?? null);
      }
      done++;
    } catch (err) {
      console.warn("[todo-sync] task push failed", { taskId: t.id, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof GraphError && (err.status === 401 || err.status === 403 || err.status === 429)) break;
    }
  }
  return done;
}

async function pullUser(pool: Pool, graph: GraphClient, listId: string, userId: string): Promise<number> {
  const open = await pool.query<{ id: string; graph_id: string }>(
    `SELECT id, graph_id FROM tasks
      WHERE assignee_user_id = $1 AND graph_id IS NOT NULL AND deleted_at IS NULL AND status <> 'COMPLETED'`,
    [userId],
  );
  if (!open.rows.length) return 0;
  const byGraph = new Map(open.rows.map((r) => [r.graph_id, r.id]));
  const completed: string[] = [];
  let next: string | null = "/me/todo/lists/" + listId + "/tasks?$filter=" + encodeURIComponent("status eq 'completed'") + "&$select=id,status&$top=100";
  for (let page = 0; next && page < 10; page++) {
    const r = await call(graph, next);
    for (const item of (r?.value ?? []) as Array<{ id?: string }>) {
      const taskId = item.id ? byGraph.get(item.id) : undefined;
      if (taskId) completed.push(taskId);
    }
    const link = typeof r?.["@odata.nextLink"] === "string" ? String(r["@odata.nextLink"]) : null;
    next = link ? link.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
  }
  if (!completed.length) return 0;
  await pool.query(
    `UPDATE tasks SET status = 'COMPLETED', completed_at = now(), updated_at = now(), graph_synced_at = now()
      WHERE id = ANY($1::uuid[]) AND status <> 'COMPLETED'`,
    [completed],
  );
  return completed.length;
}

const lastUserWarning = new Map<string, number>();
function warnUserOncePerHour(userId: string, message: string): void {
  const now = Date.now();
  if (now - (lastUserWarning.get(userId) ?? 0) < 60 * 60 * 1000) return;
  lastUserWarning.set(userId, now);
  console.warn("[todo-sync] " + message, { userId });
}

export async function reconcileTodoOnce(pool: Pool): Promise<{ users: number; pushed: number; pulled: number }> {
  const users = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT t.assignee_user_id AS user_id
       FROM tasks t JOIN users u ON u.id = t.assignee_user_id
      WHERE (u.o365_access_token IS NOT NULL OR u.o365_refresh_token IS NOT NULL)
        AND (t.graph_id IS NOT NULL OR (t.graph_synced_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'COMPLETED'))
      LIMIT $1`,
    [MAX_USERS_PER_TICK],
  );
  let pushed = 0, pulled = 0;
  for (const { user_id } of users.rows) {
    try {
      const graph = await getGraphForUser(pool, user_id);
      if (!graph) { warnUserOncePerHour(user_id, "no usable Microsoft sign-in - sign in to Microsoft in the portal"); continue; }
      const listId = await defaultListId(graph);
      if (!listId) { warnUserOncePerHour(user_id, "no To Do list found"); continue; }
      pushed += await pushUser(pool, graph, listId, user_id);
      pulled += await pullUser(pool, graph, listId, user_id);
    } catch (err) {
      warnUserOncePerHour(user_id, "sync failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  if (pushed || pulled) console.log("[todo-sync] synced", { users: users.rows.length, pushed, pulled });
  return { users: users.rows.length, pushed, pulled };
}

/** Sync one task right away (called after the portal creates or edits it). Never throws. */
export async function syncTaskNow(pool: Pool, taskId: string): Promise<void> {
  try {
    const r = await pool.query<{ assignee_user_id: string | null }>(`SELECT assignee_user_id FROM tasks WHERE id = $1`, [taskId]);
    const userId = r.rows[0]?.assignee_user_id;
    if (!userId) return;
    const graph = await getGraphForUser(pool, userId);
    if (!graph) { warnUserOncePerHour(userId, "no usable Microsoft sign-in - sign in to Microsoft in the portal"); return; }
    const listId = await defaultListId(graph);
    if (listId) await pushUser(pool, graph, listId, userId, taskId);
  } catch (err) {
    console.warn("[todo-sync] immediate sync failed", { taskId, error: err instanceof Error ? err.message : String(err) });
  }
}

export function startTodoReconcileWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileTodoOnce(pool); }
    catch (err) { logWarnSwallowed(err, "workers/todoReconcileWorker.ts:tick"); }
    finally { running = false; }
  };
  const first = setTimeout(() => void tick(), 60 * 1000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
