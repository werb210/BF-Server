// BF_SERVER_SEQ_TASK_STEP_v1 (Tasks Milestone 5) - sequences can create tasks;
// pause-until-complete parks the enrollment as 'waiting_task' and completing the
// task resumes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: vi.fn(async () => undefined) }));

import { tickSequences, resumeSequenceTask } from "../services/sequenceEngine.js";
import marketing from "../routes/marketing.js";
import tasks from "../routes/tasks.js";

const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_04_sequence_task_steps.sql"), "utf-8");

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
app.use("/api/tasks", tasks);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const EN = { id: "enr-1", sequence_id: "seq-1", contact_id: "c-1", current_step: 0, enrolled_at: "2026-10-01", last_step_at: null, stop_on_reply: false, quiet_start: 0, quiet_end: 24 };
const CONTACT = { id: "c-1", silo: "BF", owner_id: "22222222-2222-4222-8222-222222222222", email: "a@x.test", phone: null, name: "Ann Lee", sms_opt_out: false, marketing_opt_out: false, sms_consent: false, consent_basis: null, consent_at: null, line_type: null, company: null };
const taskStep = (o: Record<string, unknown> = {}) => ({ channel: "task", wait_minutes: 0, condition: "always", subject: "Call {{first_name}}", body: null, html: null, link_url: null, template_id: null, sms_template_id: null, email_template_id: null, assignee_user_id: null, task_type: "CALL", task_priority: "HIGH", task_queue_id: null, task_pause: true, ...o });

async function tickOnce(steps: unknown[], extra: SqlRule[] = []) {
  let claimed = false;
  const pool = {
    query: vi.fn(answerBySql([
      ...extra,
      [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [EN] }))],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/, { rows: steps }],
      [/FROM contacts WHERE id=\$1/, { rows: [CONTACT] }],
    ])),
  };
  await tickSequences(pool as any);
  return pool;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
});

describe("sequence task step", () => {
  it("the engine creates a SEQUENCE-sourced task for the enrollment and parks it when pausing", async () => {
    const pool = await tickOnce([taskStep(), taskStep()]);
    const [[sql, p]] = callsMatching(pool.query, /INSERT INTO tasks/) as [string, unknown[]][];
    expect(sql).toContain("'SEQUENCE', $9::uuid");
    expect(p[1]).toBe("Call Ann");
    expect(p[3]).toBe("CALL");
    expect(p[4]).toBe("HIGH");
    expect(p[8]).toBe("enr-1");
    expect(callsMatching(pool.query, /SET status='waiting_task'/)[0][1]).toEqual(["enr-1"]);
    expect(callsMatching(pool.query, /current_step=\$2/)).toHaveLength(0);
  });

  it("a non-pausing task step creates the task and advances", async () => {
    const pool = await tickOnce([taskStep({ task_pause: false }), taskStep()]);
    expect(callsMatching(pool.query, /INSERT INTO tasks/)).toHaveLength(1);
    expect(callsMatching(pool.query, /SET status='waiting_task'/)).toHaveLength(0);
    expect((callsMatching(pool.query, /current_step=\$2/)[0][1] as unknown[]).slice(0, 2)).toEqual(["enr-1", 1]);
  });

  it("resumeSequenceTask un-parks a waiting enrollment and advances it", async () => {
    const pool = {
      query: vi.fn(answerBySql([
        [/WHERE e\.id=\$1 AND e\.status='waiting_task'/, { rows: [{ id: "enr-1", sequence_id: "seq-1", current_step: 0, quiet_start: 0, quiet_end: 24 }] }],
        [/SELECT channel, wait_minutes FROM marketing_sequence_steps/, { rows: [{ channel: "task", wait_minutes: 0 }, { channel: "email", wait_minutes: 0 }] }],
      ])),
    };
    await resumeSequenceTask(pool as any, "enr-1");
    expect((callsMatching(pool.query, /current_step=\$2/)[0][1] as unknown[]).slice(0, 2)).toEqual(["enr-1", 1]);
  });

  it("resumeSequenceTask ignores an enrollment that is not waiting", async () => {
    const pool = { query: vi.fn(answerBySql([])) };
    await resumeSequenceTask(pool as any, "enr-1");
    expect(callsMatching(pool.query, /UPDATE marketing_sequence_enrollments/)).toHaveLength(0);
  });

  it.each([
    ["PATCH /:id with status COMPLETED", () => auth(request(app).patch("/api/tasks/t-1")).send({ status: "COMPLETED" })],
    ["POST /:id/complete", () => auth(request(app).post("/api/tasks/t-1/complete"))],
    ["POST /bulk complete", () => auth(request(app).post("/api/tasks/bulk")).send({ action: "complete", ids: ["t-1"] })],
  ])("%s resumes the sequence that created the task", async (_label, call) => {
    queryMock.mockImplementation(answerBySql([
      [/UPDATE tasks SET/, { rows: [{ id: "t-1", status: "COMPLETED", source: "SEQUENCE", source_ref_id: "enr-1" }], rowCount: 1 }],
    ]));
    const r = await call();
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(callsMatching(queryMock, /e\.status='waiting_task'/)).toHaveLength(1));
    expect(callsMatching(queryMock, /e\.status='waiting_task'/)[0][1]).toEqual(["enr-1"]);
  });

  it("completing a manual task resumes nothing", async () => {
    queryMock.mockImplementation(answerBySql([
      [/UPDATE tasks SET/, { rows: [{ id: "t-1", status: "COMPLETED", source: "MANUAL", source_ref_id: null }], rowCount: 1 }],
    ]));
    await auth(request(app).post("/api/tasks/t-1/complete"));
    await new Promise((r) => setTimeout(r, 10));
    expect(callsMatching(queryMock, /e\.status='waiting_task'/)).toHaveLength(0);
  });

  it("the steps route persists the task fields", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO marketing_sequences/, { rows: [{ id: "seq-9" }] }]]));
    const r = await auth(request(app).post("/api/marketing/sequences"))
      .send({ name: "Call list", includeTags: ["vip"], steps: [{ channel: "task", taskType: "CALL", taskPriority: "HIGH", taskQueueId: "q-1", taskPause: false }, { channel: "task" }] });
    expect(r.body.data).toEqual({ id: "seq-9", saved: true });
    const steps = callsMatching(queryMock, /INSERT INTO marketing_sequence_steps/).map((c) => (c[1] as unknown[]).slice(13));
    expect(steps).toEqual([["CALL", "HIGH", "q-1", false], [null, null, null, true]]);
  });

  it("the migration is idempotent", () => {
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBe(4);
  });
});
