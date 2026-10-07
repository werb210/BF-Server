// BF_SERVER_BLOCK_v_TASKS_TODO_SYNC_v1
// Mirror unified tasks (/api/tasks) into the assignee's Microsoft To Do so due
// dates + reminders reach Outlook and mobile. Best-effort / fire-and-forget.
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "./graphClient.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

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

// BF_SERVER_TODO_RECONCILE_v773 - the save-time mirror now runs the same sync as the background worker
// (correct due dates, contact name in the title, completed/deleted handled, failures logged). The
// fields passed in are ignored except id: the worker reads the saved row.
export async function mirrorTaskToTodo(pool: Pool, t: TodoTaskInput): Promise<string | null> {
  const { syncTaskNow } = await import("../../workers/todoReconcileWorker.js");
  await syncTaskNow(pool, t.id);
  return null;
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
