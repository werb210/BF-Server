import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

const ME = "00000000-0000-0000-0000-000000000001";
const token = jwt.sign({ id: ME, role: "Staff", capabilities: ["calendar:read"] }, "test-secret");

// BF_SERVER_v789_CALENDAR_TASKS_ON_TASKS - the calendar task routes read/write the unified
// tasks table (crm_tasks is retired); the SQL maps the columns back to the portal shape, so
// the mocked rows below are already in that shape (priority low|normal|high, status open|done).
describe("calendar tasks routes", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: ME, role: "staff", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
  });

  async function buildApp() {
    const router = (await import("../calendar.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/calendar", router);
    return app;
  }

  it("POST creates a task with empty dueAt and assignee, and GET returns the resolved assignee", async () => {
    const assigneeId = "22222222-2222-4222-8222-222222222222";
    const created = { id: "11111111-1111-4111-8111-111111111111", title: "t", notes: "", due_at: null, priority: "normal", status: "open", assignee_user_id: assigneeId, o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null };
    const fetched = { ...created, assignee_name: "Alice Assignee", assignee_email: "alice@example.com" };
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: ME, role: "staff", silo: "BF", silos: ["BF"] }] };
      if (/crm_tasks/.test(sql)) throw new Error("crm_tasks is retired");
      if (/INSERT INTO tasks/.test(sql)) {
        expect(sql).toContain("assignee_user_id");
        expect(sql).toContain("'TODO'");
        expect(sql).toContain("'MANUAL'");
        expect(params?.[0]).toBe(ME); // created_by
        expect(params?.[4]).toBeNull(); // due_at
        expect(params?.[5]).toBe("NONE"); // "normal" priority
        expect(params?.[6]).toBe("NOT_STARTED"); // "open" status
        expect(params?.[8]).toBe(assigneeId);
        return { rows: [created] };
      }
      if (sql.includes("ORDER BY COALESCE")) {
        expect(sql).toContain("FROM tasks t");
        expect(sql).toContain("concat_ws(' ', u.first_name, u.last_name)");
        expect(sql).toContain("LEFT JOIN users u ON u.id = t.assignee_user_id");
        expect(sql).toContain("t.deleted_at IS NULL");
        return { rows: [fetched] };
      }
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    expect((await request(app).post("/api/calendar/tasks").set("Authorization", `Bearer ${token}`).send({ title: "t", dueAt: "", priority: "normal", notes: "", assignee_user_id: assigneeId })).status).toBe(201);
    const get = await request(app).get("/api/calendar/tasks").set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body[0].title).toBe("t");
    expect(get.body[0].dueAt).toBeNull();
    expect(get.body[0].due_date).toBeNull();
    expect(get.body[0].priority).toBe("normal");
    expect(get.body[0].status).toBe("open");
    expect(get.body[0].assignee_user_id).toBe(assigneeId);
    expect(get.body[0].assignee_name).toBe("Alice Assignee");
    expect(get.body[0].assignee_email).toBe("alice@example.com");
  });

  it("POST without an assignee assigns the task to its creator (assignee_user_id is NOT NULL)", async () => {
    let insertParams: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: ME, role: "staff", silo: "BF", silos: ["BF"] }] };
      if (/INSERT INTO tasks/.test(sql)) {
        insertParams = params;
        return { rows: [{ id: "x", title: "t", notes: null, due_at: null, priority: "high", status: "done", assignee_user_id: ME, o365_task_id: null, created_at: "", updated_at: "", completed_at: "2026-01-01T00:00:00.000Z" }] };
      }
      return { rows: [] };
    });
    const app = await buildApp();
    const res = await request(app).post("/api/calendar/tasks").set("Authorization", `Bearer ${token}`).send({ title: "t", priority: "high", status: "done" });
    expect(res.status).toBe(201);
    expect(insertParams?.[5]).toBe("HIGH");
    expect(insertParams?.[6]).toBe("COMPLETED");
    expect(insertParams?.[8]).toBe(ME);
  });

  it("PATCH updates title and toggles status to done", async () => {
    let updateSql = "";
    let updateParams: unknown[] = [];
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: ME, role: "staff", silo: "BF", silos: ["BF"] }] };
      if (/crm_tasks/.test(sql)) throw new Error("crm_tasks is retired");
      if (sql.includes("LIMIT 1") && /FROM tasks t/.test(sql)) return { rows: [{ id: "1", title: "t", notes: null, due_at: null, priority: "normal", status: "open", assignee_user_id: ME, o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null }] };
      if (/UPDATE tasks t SET/.test(sql)) {
        updateSql = sql;
        updateParams = params ?? [];
        return { rows: [{ id: "1", title: "t2", notes: null, due_at: null, priority: "normal", status: "done", assignee_user_id: ME, o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z", completed_at: "2026-01-01T00:00:01.000Z" }] };
      }
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    const res = await request(app).patch("/api/calendar/tasks/1").set("Authorization", `Bearer ${token}`).send({ title: "t2", status: "done", priority: "normal" });
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
    expect(res.body.status).toBe("done");
    expect(updateParams).toContain("COMPLETED");
    // priority unchanged at the portal level -> not rewritten
    expect(updateSql).not.toContain("priority =");
    expect(updateSql).toContain("completed_at = NOW()");
  });

  it("DELETE soft-deletes it and GET returns empty", async () => {
    let deleteSql = "";
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: ME, role: "staff", silo: "BF", silos: ["BF"] }] };
      if (/crm_tasks/.test(sql)) throw new Error("crm_tasks is retired");
      if (/SET deleted_at = NOW\(\)/.test(sql)) { deleteSql = sql; return { rows: [{ o365_task_id: null }] }; }
      if (sql.includes("ORDER BY COALESCE")) return { rows: [] };
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    expect((await request(app).delete("/api/calendar/tasks/1").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect(deleteSql).toContain("UPDATE tasks");
    const get = await request(app).get("/api/calendar/tasks").set("Authorization", `Bearer ${token}`);
    expect(get.body).toEqual([]);
  });

  it("POST without a title returns 400", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/calendar/tasks").set("Authorization", `Bearer ${token}`).send({ notes: "x" });
    expect(res.status).toBe(400);
  });
});
