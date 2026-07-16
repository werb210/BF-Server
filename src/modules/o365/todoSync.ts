// BF_SERVER_BLOCK_v_TASKS_TODO_SYNC_v1
// Mirror unified tasks (/api/tasks) into the assignee's Microsoft To Do so due
// dates + reminders reach Outlook and mobile. Best-effort / fire-and-forget.
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "./graphClient.js";

async function call(graph: GraphClient, path: string, init?: RequestInit): Promise<any> {
  const resp = await graph.fetch(path, init);
  if (!resp.ok) throw new Error(`graph_${resp.status}`);
  if (resp.status === 204) return null;
  const t = await resp.text();
  return t ? JSON.parse(t) : null;
}

async function defaultListId(graph: GraphClient): Promise<string | null> {
  const lists = await call(graph, "/me/todo/lists?$top=20");
  const all: Array<{ id?: string; wellknownListName?: string }> = lists?.value ?? [];
  return (all.find((l) => l.wellknownListName === "defaultList") ?? all[0])?.id ?? null;
}

function importanceFor(priority?: string | null): "low" | "normal" | "high" {
  const v = String(priority ?? "").toUpperCase();
  return v === "HIGH" ? "high" : v === "LOW" ? "low" : "normal";
}

export interface TodoTaskInput {
  id: string;
  userId?: string | null;
  graphId?: string | null;
  title?: string | null;
  body?: string | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  priority?: string | null;
  status?: string | null;
  contactId?: string | null;
}

export async function mirrorTaskToTodo(pool: Pool, t: TodoTaskInput): Promise<string | null> {
  try {
    if (!t.userId) return null;
    const graph = await getGraphForUser(pool, t.userId);
    if (!graph) return null;
    const listId = await defaultListId(graph);
    if (!listId) return null;
    const payload: Record<string, unknown> = {
      title: t.title ?? "Task",
      body: t.body ? { content: String(t.body), contentType: "text" } : undefined,
      dueDateTime: t.dueAt ? { dateTime: new Date(t.dueAt).toISOString(), timeZone: "UTC" } : undefined,
      importance: importanceFor(t.priority),
      status: t.status === "done" ? "completed" : "notStarted",
    };
    if (t.reminderAt) {
      payload.isReminderOn = true;
      payload.reminderDateTime = { dateTime: new Date(t.reminderAt).toISOString(), timeZone: "UTC" };
    }
    if (t.contactId && !t.graphId) {
      payload.linkedResources = [{
        webUrl: `https://staff.boreal.financial/crm/contacts/${t.contactId}`,
        applicationName: "Boreal CRM",
        displayName: t.title ?? "Contact",
      }];
    }
    const path = t.graphId
      ? `/me/todo/lists/${listId}/tasks/${t.graphId}`
      : `/me/todo/lists/${listId}/tasks`;
    const method = t.graphId ? "PATCH" : "POST";
    const result = await call(graph, path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const gid: string | null = (result as { id?: string } | null)?.id ?? t.graphId ?? null;
    if (gid && gid !== t.graphId) {
      await pool.query(`UPDATE tasks SET graph_id = $1 WHERE id = $2`, [gid, t.id]).catch(() => {});
    }
    return gid;
  } catch {
    return null;
  }
}

export async function deleteTodoTask(pool: Pool, userId: string | null | undefined, graphId: string | null | undefined): Promise<void> {
  if (!graphId || !userId) return;
  try {
    const graph = await getGraphForUser(pool, userId);
    if (!graph) return;
    const listId = await defaultListId(graph);
    if (!listId) return;
    await call(graph, `/me/todo/lists/${listId}/tasks/${graphId}`, { method: "DELETE" });
  } catch {
    /* best-effort */
  }
}
