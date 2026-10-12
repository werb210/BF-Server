// BF_SERVER_TASKS_V1 - Milestone 1: silo-scoped tasks + queues CRUD, views,
// first-class completed_at, label-only queue delete, soft task delete.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";
import tasksRoutes from "../routes/tasks.js";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: vi.fn(async () => undefined) }));
vi.mock("../services/sequenceEngine.js", () => ({ resumeSequenceTask: vi.fn(async () => undefined) }));

const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_04_tasks_v1.sql"), "utf-8");
const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const QUEUE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TASK = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const MATE = "cccccccc-dddd-4eee-8fff-000000000000";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function api(method: "get" | "post" | "patch" | "delete", path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", tasksRoutes);
  const r = (request(app) as any)[method](`/api/tasks${path}`).set("Authorization", `Bearer ${token()}`).set("X-Silo", "BI");
  return body === undefined ? r : r.send(body);
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM users WHERE id = \$1/, { rows: [{ id: STAFF_ID, role: "Admin", silo: "BF", silos: ["BF", "BI"] }], rowCount: 1 }],
    [/FROM users/, { rows: [{ id: MATE, name: "Andrew Mate", email: "andrew@boreal.financial" }], rowCount: 1 }],
    [/FROM tasks t/, { rows: [{ id: TASK, title: "Call Jordan", contact_phone: "+15874441234" }], rowCount: 1 }],
    [/UPDATE tasks SET status = ?'COMPLETED'/, { rows: [{ id: TASK, source: "MANUAL", repeat_active: false }], rowCount: 1 }],
    [/UPDATE tasks SET deleted_at/, { rows: [{ id: TASK, repeat_active: false }], rowCount: 1 }],
    [/./, { rows: [{ id: QUEUE, name: "Follow-ups", access_type: "PRIVATE" }], rowCount: 1 }],
  ]));
});

const taskSql = () => queryMock.mock.calls.filter(([sql]) => /\b(tasks|task_queues|task_queue_shares)\b/.test(sqlText(sql)));

describe("tasks milestone 1", () => {
  it("mounted at /api/tasks", () => {
    expect(API_ROUTE_MOUNTS.filter((m) => m.router === tasksRoutes).map((m) => m.path)).toEqual(["/tasks"]);
  });

  it("every read/write is silo-scoped to the caller's active silo", async () => {
    const calls: Array<[Parameters<typeof api>[0], string, unknown?]> = [
      ["get", "/queues"], ["post", "/queues", { name: "Follow-ups" }], ["patch", `/queues/${QUEUE}`, { name: "Renamed" }],
      ["delete", `/queues/${QUEUE}`], ["get", `/queues/${QUEUE}/shares`], ["post", `/queues/${QUEUE}/shares`, { user_id: MATE }],
      ["delete", `/queues/${QUEUE}/shares/${MATE}`], ["post", "/runs", {}], ["get", "/?view=overdue"],
      ["post", `/${TASK}/complete`], ["post", "/bulk", { action: "complete", ids: [TASK] }], ["delete", `/${TASK}`],
    ];
    for (const [m, p, b] of calls) {
      const res = await api(m, p, b);
      expect(res.status, `${m} ${p}`).toBe(200);
    }
    const scoped = taskSql();
    expect(scoped.length).toBeGreaterThan(8);
    for (const [sql, params] of scoped) {
      expect(sqlText(sql)).toMatch(/silo/);
      expect(params as unknown[], sqlText(sql)).toContain("BI");
    }
  });

  it("complete stamps completed_at; delete is soft; queue delete keeps tasks", async () => {
    await api("post", `/${TASK}/complete`);
    expect(sqlText(callsMatching(queryMock, /UPDATE tasks SET status = 'COMPLETED'/)[0]![0])).toContain("completed_at = now()");

    queryMock.mockClear();
    await api("delete", `/${TASK}`);
    expect(callsMatching(queryMock, /UPDATE tasks SET deleted_at = now\(\)/)).toHaveLength(1);
    expect(callsMatching(queryMock, /DELETE FROM tasks/)).toHaveLength(0);

    queryMock.mockClear();
    await api("delete", `/queues/${QUEUE}`);
    const order = queryMock.mock.calls.map(([sql]) => sqlText(sql));
    const unlabel = order.findIndex((s) => s.includes("UPDATE tasks SET queue_id = NULL"));
    const drop = order.findIndex((s) => s.includes("DELETE FROM task_queues"));
    expect(unlabel).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(unlabel);
    expect(order.some((s) => /DELETE FROM tasks\b/.test(s))).toBe(false);
  });

  it("migration is idempotent and covers all three silos", () => {
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBeGreaterThan(5);
    expect(mig).toContain("('BF','BI','SLF')");
  });
});

// BF_SERVER_TASKS_M2_M3_v1 - queue shares (owner-only), staff picker, and the
// stateless Start-N-tasks run with strict-per-task completion binding.
describe("tasks milestones 2+3", () => {
  it("exposes shares CRUD and a staff picker", async () => {
    expect((await api("get", `/queues/${QUEUE}/shares`)).status).toBe(200);
    const add = await api("post", `/queues/${QUEUE}/shares`, { user_id: MATE });
    expect(add.status).toBe(200);
    const [ins] = callsMatching(queryMock, /INSERT INTO task_queue_shares/);
    expect(sqlText(ins![0])).toContain("ON CONFLICT (queue_id, user_id) DO NOTHING");
    expect(ins![1]).toEqual([QUEUE, MATE, "BI"]);
    expect((await api("delete", `/queues/${QUEUE}/shares/${MATE}`)).status).toBe(200);
    const staff = await api("get", "/staff");
    expect(staff.status).toBe(200);
    expect(JSON.stringify(staff.body)).toContain("andrew@boreal.financial");
  });

  it("runs return ordered open tasks with contact channels", async () => {
    const res = await api("post", "/runs", { view: "overdue" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("+15874441234");
    const [run] = callsMatching(queryMock, /FROM tasks t/);
    expect(sqlText(run![0])).toContain("c.phone AS contact_phone");
    expect(sqlText(run![0])).toContain("t.status <> 'COMPLETED'");
  });
});
