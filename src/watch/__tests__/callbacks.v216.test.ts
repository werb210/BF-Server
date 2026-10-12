// BF_SERVER_WATCH_CALLBACKS_v216
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

const migrations = readdirSync("migrations")
  .map((f) => readFileSync(`migrations/${f}`, "utf-8"))
  .join("\n");

const STAFF = "00000000-0000-4000-8000-0000000000b1";
const DUE = [{ id: "t1", title: "Call back Jane", dueAt: "2026-10-11T15:00:00Z", overdue: true, contactId: "c1", contactName: "Jane", number: "+15875550142" }];
const TASKS_SQL = /FROM tasks t/;

function db(tasks: unknown = { rows: DUE }) {
  h.query.mockImplementation(answerBySql([
    [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: "sess-1", staff_user_id: STAFF, role: "Staff", silo: "BF", silos: ["BF"] }] }],
    [TASKS_SQL, tasks],
  ]));
}

async function callbacks(query = "line=BF") {
  const { issueWatchAccessToken } = await import("../security.js");
  const router = (await import("../dataRoutes.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/watch", router);
  const { accessToken } = issueWatchAccessToken(STAFF, "dev-1", "sess-1");
  return request(app).get(`/api/watch/callbacks?${query}`).set("Authorization", `Bearer ${accessToken}`);
}
const tasksQuery = () => {
  const [sql, params] = callsMatching(h.query, TASKS_SQL)[0]!;
  return { sql: sqlText(sql), params: params as unknown[] };
};

beforeEach(() => { h.query.mockReset(); db(); });

describe("what counts as a callback", () => {
  it("returns the calls with the number, so the watch can dial without another call", async () => {
    const res = await callbacks();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: DUE, count: 1 });
    expect(tasksQuery().sql).toContain("c.phone           AS number");
  });

  it("only lists tasks with a contact who has a phone number", async () => {
    // A task with nobody to ring is a to-do. Counting it makes the number lie.
    await callbacks();
    const { sql } = tasksQuery();
    expect(sql).toContain("JOIN contacts c ON c.id = t.contact_id");
    expect(sql).toContain("COALESCE(NULLIF(TRIM(c.phone), ''), NULL) IS NOT NULL");
  });

  it("includes overdue calls rather than hiding them, most overdue first", async () => {
    await callbacks();
    const { sql } = tasksQuery();
    expect(sql).toContain("t.due_at < date_trunc('day', now()) + interval '1 day'");
    expect(sql).toContain("(t.due_at < now()) AS overdue");
    expect(sql).toContain("ORDER BY t.due_at ASC");
  });
});

describe("it targets the live schema", () => {
  it("reads tasks, not the retired crm_tasks", async () => {
    await callbacks();
    expect(callsMatching(h.query, /crm_tasks/)).toHaveLength(0);
    expect(tasksQuery().sql).toContain("FROM tasks t");
  });

  it("uses only columns tasks and contacts actually have", async () => {
    expect(migrations).toContain("assignee_user_id");
    expect(migrations).toMatch(/CREATE TABLE IF NOT EXISTS contacts[\s\S]{0,400}phone text/);
    await callbacks();
    expect(tasksQuery().sql).toContain("t.assignee_user_id = $1::uuid");
  });

  it("uses status values the CHECK constraint permits", async () => {
    await callbacks();
    const { sql } = tasksQuery();
    for (const s of ["COMPLETED", "DEFERRED"]) {
      expect(migrations).toContain(`'${s}'`);
      expect(sql).toContain(`'${s}'`);
    }
  });
});

describe("it cannot fail silently", () => {
  it("logs rather than swallowing, so a schema slip is visible", async () => {
    db(new Error('column t.assignee_user_id does not exist'));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await callbacks();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], count: 0 });
      expect(err).toHaveBeenCalledWith("[watch] callbacks query failed", { message: "column t.assignee_user_id does not exist" });
    } finally {
      err.mockRestore();
    }
  });

  it("scopes to one silo and the signed-in staff user", async () => {
    await callbacks("line=bf");
    const { sql, params } = tasksQuery();
    expect(sql).toContain("t.silo = $2");
    expect(params.slice(0, 2)).toEqual([STAFF, "BF"]);
    h.query.mockClear();
    const other = await callbacks("line=BI");
    expect(other.status).toBe(403);
    expect(callsMatching(h.query, TASKS_SQL)).toHaveLength(0);
  });

  it("bounds the result set", async () => {
    await callbacks("line=BF");
    expect(tasksQuery().params[2]).toBe(20);
    h.query.mockClear();
    await callbacks("line=BF&limit=500");
    expect(tasksQuery().params[2]).toBe(50);
  });
});
