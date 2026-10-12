// BF_SERVER_SEQ_STEP_ASSIGNEE_v1 - a BF task step can name its assignee.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import { tickSequences } from "../services/sequenceEngine.js";
import marketing from "../routes/marketing.js";

const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_step_assignee_v1.sql"), "utf-8");

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const CADEN = "33333333-3333-4333-8333-333333333333";
const OWNER = "22222222-2222-4222-8222-222222222222";
const EN = { id: "enr-1", sequence_id: "seq-1", contact_id: "c-1", current_step: 0, enrolled_at: "2026-10-01", last_step_at: null, stop_on_reply: false, quiet_start: 0, quiet_end: 24 };
const taskStep = (assignee: string | null) => ({ channel: "task", wait_minutes: 0, condition: "always", subject: "Call", body: null, html: null, link_url: null, template_id: null, sms_template_id: null, email_template_id: null, assignee_user_id: assignee, task_type: "CALL", task_priority: "NONE", task_queue_id: null, task_pause: true });

async function runTaskStep(assignee: string | null, ownerId: string | null) {
  let claimed = false;
  const pool = {
    query: vi.fn(answerBySql([
      [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [EN] }))],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/, { rows: [taskStep(assignee)] }],
      [/FROM contacts WHERE id=\$1/, { rows: [{ id: "c-1", silo: "BF", owner_id: ownerId, email: "a@x.test", phone: null, name: "Ann", company: null }] }],
    ])),
  };
  await tickSequences(pool as any);
  const [[sql, params]] = callsMatching(pool.query, /INSERT INTO tasks/) as [string, unknown[]][];
  return { pool, sql, assigneeParam: params[6] };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/INSERT INTO marketing_sequences/, { rows: [{ id: "seq-9" }] }]]));
});

describe("a BF task step can name its assignee", () => {
  it("prefers the step's assignee over the contact owner", async () => {
    expect((await runTaskStep(CADEN, OWNER)).assigneeParam).toBe(CADEN);
  });

  it("keeps the contact-owner default when none is chosen, then the first active Admin", async () => {
    expect((await runTaskStep(null, OWNER)).assigneeParam).toBe(OWNER);
    const none = await runTaskStep(null, null);
    expect(none.assigneeParam).toBeNull();
    expect(none.sql).toContain("COALESCE($7::uuid, (SELECT id FROM users WHERE active = true ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1))");
  });

  it("reads the column from the steps query", async () => {
    const { pool } = await runTaskStep(CADEN, OWNER);
    expect(String(callsMatching(pool.query, /FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/)[0][0])).toContain("email_template_id, assignee_user_id, task_type");
  });
});

describe("the assignee persists and reads back", () => {
  it("is uuid-guarded on insert, camelCase or snake_case", async () => {
    await auth(request(app).post("/api/marketing/sequences")).send({
      name: "Calls", includeTags: ["vip"],
      steps: [{ channel: "task", assigneeUserId: CADEN }, { channel: "task", assignee_user_id: OWNER }, { channel: "task", assigneeUserId: "caden" }, { channel: "task" }],
    });
    const assignees = callsMatching(queryMock, /INSERT INTO marketing_sequence_steps/).map((c) => (c[1] as unknown[])[12]);
    expect(assignees).toEqual([CADEN, OWNER, null, null]);
  });

  it("is returned when a sequence is read back", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM marketing_sequences WHERE id=\$1 AND silo=\$2/, { rows: [{ id: "seq-1", name: "Calls" }], rowCount: 1 }],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1/, { rows: [{ step_order: 0, channel: "task", assignee_user_id: CADEN }] }],
    ]));
    const r = await auth(request(app).get("/api/marketing/sequences/seq-1"));
    expect(r.body.data.steps[0].assignee_user_id).toBe(CADEN);
    expect(String(callsMatching(queryMock, /FROM marketing_sequence_steps/)[0][0])).toContain("email_template_id, assignee_user_id, task_type, task_priority, task_queue_id, task_pause FROM marketing_sequence_steps");
  });

  it("has matching placeholder, column and parameter counts", async () => {
    await auth(request(app).post("/api/marketing/sequences")).send({ name: "Calls", includeTags: ["vip"], steps: [{ channel: "task" }] });
    const [[sql, params]] = callsMatching(queryMock, /INSERT INTO marketing_sequence_steps/) as [string, unknown[]][];
    const columns = (sql.match(/\(sequence_id[^)]+\)/)?.[0] ?? "").split(",").length;
    const placeholders = (sql.match(/VALUES \(([^)]+)\)/)?.[1] ?? "").split(",").length;
    expect(columns).toBe(17);
    expect(placeholders).toBe(17);
    expect(params).toHaveLength(17);
  });

  it("adds the column idempotently and nullable", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS assignee_user_id UUID");
    expect(migration).not.toContain("NOT NULL");
  });
});
