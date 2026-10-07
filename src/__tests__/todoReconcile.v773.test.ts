// BF_SERVER_TODO_RECONCILE_v773
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const graphCalls: Array<{ path: string; method: string; body?: any }> = [];
let graphAnswer: (path: string, method: string) => { status: number; json?: unknown } = () => ({ status: 200, json: {} });
vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: async (_pool: unknown, userId: string) => userId === "no-ms" ? null : {
    accessToken: "t",
    fetch: async (path: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      graphCalls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = graphAnswer(path, method);
      return { ok: a.status < 400, status: a.status, text: async () => (a.json === undefined ? "" : JSON.stringify(a.json)) } as unknown as Response;
    },
  },
}));
import { reconcileTodoOnce, todoDueDate, todoTitle, todoPayload, type PendingTask } from "../workers/todoReconcileWorker.js";

type Q = { sql: string; params: unknown[] };
function fakePool(tasks: PendingTask[], openSynced: Array<{ id: string; graph_id: string }> = []) {
  const queries: Q[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT DISTINCT t.assignee_user_id")) return { rows: [{ user_id: "u1" }] };
      if (sql.includes("FROM tasks t") && sql.includes("LEFT JOIN contacts")) return { rows: tasks };
      if (sql.includes("SELECT id, graph_id FROM tasks")) return { rows: openSynced };
      return { rows: [], rowCount: 1 };
    },
  };
  return { pool: pool as any, queries };
}
const task = (over: Partial<PendingTask>): PendingTask => ({ id: "t1", title: "Follow up", body: null, status: "NOT_STARTED", priority: "NONE", due_at: "2026-09-29T00:19:00Z", reminder_at: null, deleted_at: null, graph_id: null, contact_id: "c1", contact_name: "Clarice Gray", ...over });

beforeEach(() => {
  graphCalls.length = 0;
  graphAnswer = (path, method) => path.startsWith("/me/todo/lists?") ? { status: 200, json: { value: [{ id: "L1", wellknownListName: "defaultList" }] } }
    : method === "POST" ? { status: 201, json: { id: "G-new" } } : { status: 200, json: { value: [] } };
});

describe("payload", () => {
  it("keeps the Alberta due date (6:19 PM Sep 28 is not Sep 29) and names the contact", () => {
    expect(todoDueDate("2026-09-29T00:19:00Z").dateTime.slice(0, 10)).toBe("2026-09-28");
    expect(todoTitle({ title: "Follow up", contact_name: "Clarice Gray" })).toBe("Follow up - Clarice Gray");
    expect(todoTitle({ title: "Call Stephen", contact_name: "Stephen" })).toBe("Call Stephen");
  });
  it("completed tasks are completed in To Do with no reminder", () => {
    const p = todoPayload(task({ status: "COMPLETED" }));
    expect(p.status).toBe("completed");
    expect(p.isReminderOn).toBe(false);
  });
});

describe("reconcile", () => {
  it("creates To Do items for tasks no portal screen ever sent (e.g. abandoned-application calls)", async () => {
    const { pool, queries } = fakePool([task({})]);
    const r = await reconcileTodoOnce(pool);
    expect(r.pushed).toBe(1);
    const post = graphCalls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/me/todo/lists/L1/tasks");
    expect(post.body.title).toBe("Follow up - Clarice Gray");
    expect(queries.some((q) => q.sql.includes("graph_synced_at = updated_at") && q.params[1] === "G-new")).toBe(true);
  });
  it("deletes in To Do when the portal task was deleted, and completes when completed", async () => {
    const { pool } = fakePool([task({ id: "d", graph_id: "G-d", deleted_at: "2026-10-01T00:00:00Z" }), task({ id: "c", graph_id: "G-c", status: "COMPLETED" })]);
    await reconcileTodoOnce(pool);
    expect(graphCalls.some((c) => c.method === "DELETE" && c.path.endsWith("/G-d"))).toBe(true);
    const patch = graphCalls.find((c) => c.method === "PATCH" && c.path.endsWith("/G-c"))!;
    expect(patch.body.status).toBe("completed");
  });
  it("a task ticked off in To Do completes the portal task", async () => {
    graphAnswer = (path) => path.startsWith("/me/todo/lists?") ? { status: 200, json: { value: [{ id: "L1", wellknownListName: "defaultList" }] } }
      : { status: 200, json: { value: [{ id: "G-done", status: "completed" }] } };
    const { pool, queries } = fakePool([], [{ id: "11111111-1111-1111-1111-111111111111", graph_id: "G-done" }, { id: "22222222-2222-2222-2222-222222222222", graph_id: "G-open" }]);
    const r = await reconcileTodoOnce(pool);
    expect(r.pulled).toBe(1);
    const upd = queries.find((q) => q.sql.includes("SET status = 'COMPLETED'"))!;
    expect(upd.params[0]).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
  it("a task deleted in To Do stops syncing instead of failing every 5 minutes", async () => {
    graphAnswer = (path, method) => path.startsWith("/me/todo/lists?") ? { status: 200, json: { value: [{ id: "L1" }] } } : method === "PATCH" ? { status: 404 } : { status: 200, json: { value: [] } };
    const { pool, queries } = fakePool([task({ graph_id: "G-gone" })]);
    await reconcileTodoOnce(pool);
    expect(queries.some((q) => q.sql.includes("SET graph_id = $2, graph_synced_at = updated_at") && q.params[1] === null)).toBe(true);
  });
});

describe("wiring", () => {
  it("the worker starts with the server and the save-time mirror uses it", () => {
    expect(readFileSync("src/index.ts", "utf8")).toContain("startTodoReconcileWorker(pool)");
    expect(readFileSync("src/modules/o365/todoSync.ts", "utf8")).toContain("syncTaskNow(pool, t.id)");
    expect(readFileSync("migrations/2026_10_07_v773_tasks_todo_sync.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS graph_synced_at");
  });
});
