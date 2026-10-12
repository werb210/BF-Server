// BF_SERVER_TASKS_M6_v1 (Tasks Milestone 6) - recurrence regeneration on
// complete/delete/overdue, reminder->notification, and the daily digest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, pool: { query: q, connect: vi.fn() } };
});
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: async () => undefined }));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));
import tasksRouter from "../routes/tasks.js";
import { startTaskRemindersWorker } from "../workers/taskRemindersWorker.js";

const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_05_tasks_m6.sql"), "utf-8");

const app = express();
app.use(express.json());
app.use("/api/tasks", tasksRouter);
const staff = "Bearer " + jwt.sign({ sub: "66666666-6666-4666-8666-666666666666", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

const recurring = {
  id: "t-1", silo: "BF", title: "Weekly check-in", body: null, type: "CALL", priority: "NONE",
  due_at: "2026-10-01T15:00:00.000Z", assignee_user_id: "u-1", repeat_active: true, repeat_interval: 1, repeat_unit: "WEEK",
};
const REGEN = /INSERT INTO tasks[\s\S]*repeat_parent_id[\s\S]*FROM tasks WHERE id::text = \$1/;

function answer(rules: SqlRule[]) { query.mockImplementation(answerBySql(rules)); }
beforeEach(() => { query.mockReset(); answer([]); });
afterEach(() => { vi.useRealTimers(); });

describe("tasks milestone 6", () => {
  it("regenerates recurrence on complete", async () => {
    answer([[/UPDATE tasks SET status = 'COMPLETED'/, { rows: [recurring], rowCount: 1 }]]);
    const r = await request(app).post("/api/tasks/t-1/complete").set("Authorization", staff);
    expect(r.status).toBe(200);
    const regen = callsMatching(query, REGEN);
    expect(regen).toHaveLength(1);
    expect(regen[0][0]).toContain("NOT EXISTS (SELECT 1 FROM tasks c WHERE c.repeat_parent_id");
    expect(regen[0][1]).toEqual(["t-1", "2026-10-08T15:00:00.000Z"]);
  });

  it("regenerates recurrence on delete", async () => {
    answer([[/UPDATE tasks SET deleted_at = now\(\)/, { rows: [{ ...recurring, repeat_interval: 1, repeat_unit: "MONTH" }], rowCount: 1 }]]);
    const r = await request(app).delete("/api/tasks/t-1").set("Authorization", staff);
    expect(r.status).toBe(200);
    expect(callsMatching(query, REGEN)[0][1]).toEqual(["t-1", "2026-11-01T15:00:00.000Z"]);
  });

  it("does not regenerate a task that does not repeat", async () => {
    answer([[/UPDATE tasks SET status = 'COMPLETED'/, { rows: [{ ...recurring, repeat_active: false }], rowCount: 1 }]]);
    await request(app).post("/api/tasks/t-1/complete").set("Authorization", staff);
    expect(callsMatching(query, REGEN)).toHaveLength(0);
  });

  it("worker runs reminders, overdue recurrence catch-up, and digest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z")); // after 08:00 UTC: the digest runs
    const pool = {
      query: vi.fn(answerBySql([
        [/FROM tasks t\s+WHERE t\.repeat_active = true/, { rows: [{ ...recurring, id: "t-overdue", queue_id: null, contact_id: null, company_id: null, created_by: null }] }],
      ])),
    };
    const w = startTaskRemindersWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /UPDATE task_digest_log SET notified_at/)).toHaveLength(1));
    w.stop();

    const reminder = callsMatching(pool.query, /INSERT INTO notifications[\s\S]*FROM tasks t/)[0][0] as string;
    expect(reminder).toContain("'task_reminder'");
    expect(callsMatching(pool.query, /UPDATE tasks SET reminder_sent_at = now\(\)/)).toHaveLength(1);

    const catchup = callsMatching(pool.query, /INSERT INTO tasks[\s\S]*VALUES \(\$1/);
    expect(catchup).toHaveLength(1);
    const params = catchup[0][1] as unknown[];
    expect(params[5]).toBe("2026-10-08T15:00:00.000Z");
    expect(params[13]).toBe("t-overdue"); // repeat_parent_id

    expect(callsMatching(pool.query, /INSERT INTO task_digest_log/)[0][0]).toContain("ON CONFLICT (user_id, digest_date) DO NOTHING");
    expect(callsMatching(pool.query, /'task_digest'/)).toHaveLength(1);
  });

  it("is mounted at startup and migration is idempotent", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startTaskRemindersWorker")).toEqual([[boot.pool]]);
    } finally { boot.restore(); }
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBe(2);
    expect(mig).toContain("task_digest_log");
  });
});
