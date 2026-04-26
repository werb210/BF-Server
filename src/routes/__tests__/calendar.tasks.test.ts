import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

const token = jwt.sign({ id: "00000000-0000-0000-0000-000000000001", capabilities: ["calendar:read"] }, "test-secret");

describe("calendar tasks routes", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
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

  it("POST creates a task and GET returns it", async () => {
    const created = { id: "11111111-1111-4111-8111-111111111111", title: "t", notes: "", due_at: null, priority: "normal", status: "open", o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("INSERT INTO calendar_tasks")) return { rows: [created] };
      if (sql.includes("ORDER BY COALESCE")) return { rows: [created] };
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    expect((await request(app).post("/api/calendar/tasks").set("Authorization", `Bearer ${token}`).send({ title: "t", dueAt: null, priority: "normal", notes: "" })).status).toBe(201);
    const get = await request(app).get("/api/calendar/tasks").set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body[0].title).toBe("t");
  });

  it("PATCH updates title and toggles status to done", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("LIMIT 1")) return { rows: [{ id: "1", title: "t", notes: null, due_at: null, priority: "normal", status: "open", o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null }] };
      if (sql.includes("UPDATE calendar_tasks SET")) return { rows: [{ id: "1", title: "t2", notes: null, due_at: null, priority: "normal", status: "done", o365_task_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z", completed_at: "2026-01-01T00:00:01.000Z" }] };
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    const res = await request(app).patch("/api/calendar/tasks/1").set("Authorization", `Bearer ${token}`).send({ title: "t2", status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
  });

  it("DELETE removes it and GET returns empty", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1") && sql.includes("silos")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("DELETE FROM calendar_tasks")) return { rows: [{ o365_task_id: null }] };
      if (sql.includes("ORDER BY COALESCE")) return { rows: [] };
      if (sql.includes("SELECT o365_access_token")) return { rows: [{ o365_access_token: null, o365_token_expires_at: null }] };
      return { rows: [] };
    });
    const app = await buildApp();
    expect((await request(app).delete("/api/calendar/tasks/1").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    const get = await request(app).get("/api/calendar/tasks").set("Authorization", `Bearer ${token}`);
    expect(get.body).toEqual([]);
  });

  it("POST without a title returns 400", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/calendar/tasks").set("Authorization", `Bearer ${token}`).send({ notes: "x" });
    expect(res.status).toBe(400);
  });
});
