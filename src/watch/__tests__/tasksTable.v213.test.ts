// BF_SERVER_TASKS_TABLE_FIX_v213
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../nextMeeting.js", async (orig) => ({ ...(await orig<typeof import("../nextMeeting.js")>()), nextMeetingFor: vi.fn(async () => null) }));

const migration = readFileSync("migrations/2026_09_15_v213_tasks_source_call_disposition.sql", "utf-8");

function tasksSchema(): string {
  const dir = "migrations";
  for (const f of readdirSync(dir)) {
    const sql = readFileSync(`${dir}/${f}`, "utf-8");
    if (sql.includes("CREATE TABLE IF NOT EXISTS tasks (")) return sql;
  }
  throw new Error("tasks table definition not found");
}

const STAFF = "00000000-0000-4000-8000-0000000000b1";
const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function snapshot() {
  h.query.mockImplementation(answerBySql([[/FROM tasks/, { rows: [{ count: "3" }] }]]));
  const { buildWatchSnapshot } = await import("../snapshotRoutes.js");
  const out = await buildWatchSnapshot(STAFF);
  const [sql, params] = callsMatching(h.query, /FROM tasks/)[0]!;
  return { out, sql: sqlText(sql), params };
}

beforeEach(() => { h.query.mockReset(); });

describe("the snapshot counts the live table", () => {
  it("no longer reads the retired crm_tasks", async () => {
    const { out, sql } = await snapshot();
    expect(out.tasksDue).toBe(3);
    expect(sql).toContain("FROM tasks");
    expect(callsMatching(h.query, /crm_tasks/)).toHaveLength(0);
  });

  it("uses the column tasks actually has", async () => {
    const schema = tasksSchema();
    expect(schema).toContain("assignee_user_id");
    const { sql, params } = await snapshot();
    expect(sql).toContain("assignee_user_id = $1::uuid");
    expect(params).toEqual([STAFF]);
    // assigned_to / owner_id are crm_tasks columns and do not exist here.
    expect(sql).not.toContain("assigned_to");
    expect(sql).not.toContain("owner_id");
  });

  it("uses status values the CHECK constraint permits", async () => {
    const schema = tasksSchema();
    const { sql } = await snapshot();
    for (const status of ["COMPLETED", "DEFERRED"]) {
      expect(schema).toContain(`'${status}'`);
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).not.toContain("lower(COALESCE(status");
  });

  it("still includes overdue tasks", async () => {
    const { sql } = await snapshot();
    expect(sql).toContain("due_at < date_trunc('day', now()) + interval '1 day'");
  });
});

describe("the follow-up task that never inserted", () => {
  it("writes a source the constraint now allows", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: "sess-1", staff_user_id: STAFF, role: "Staff", silo: "BF", silos: ["BF"] }] }],
      [/UPDATE call_logs SET disposition/, { rows: [{ id: CALL, contact_id: CONTACT, silo: "BF" }], rowCount: 1 }],
    ]));
    const { issueWatchAccessToken } = await import("../security.js");
    const router = (await import("../dataRoutes.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/watch", router);
    const { accessToken } = issueWatchAccessToken(STAFF, "dev-1", "sess-1");
    const res = await request(app).post(`/api/watch/calls/${CALL}/disposition`).set("Authorization", `Bearer ${accessToken}`).send({ disposition: "follow_up" });
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /INSERT INTO tasks/)[0]!;
    expect(sqlText(sql)).toContain("'CALL_DISPOSITION'");
    expect(params).toEqual(["BF", "Follow up on call", "Auto-created from call outcome: follow_up", "2", STAFF, CONTACT, CALL]);
    expect(migration).toContain("'CALL_DISPOSITION'");
  });

  it("keeps every source value that was already permitted", () => {
    for (const s of ["MANUAL", "SEQUENCE", "WORKFLOW", "IMPORT", "API"]) {
      expect(migration).toContain(`'${s}'`);
    }
  });

  it("replaces the constraint rather than dropping the check entirely", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS tasks_source_check");
    expect(migration).toContain("ADD CONSTRAINT tasks_source_check");
  });

  it("indexes the lookup the watch snapshot now makes every refresh", () => {
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS tasks_assignee_due_open_idx");
  });
});
