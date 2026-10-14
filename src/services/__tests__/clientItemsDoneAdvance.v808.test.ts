// BF_SERVER_v808_STAGE_ADVANCE - when the client has nothing left to do, Additional Steps moves on by itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";

const h = vi.hoisted(() => ({ query: vi.fn(), sent: 0, state: "Additional Steps Required" }));
vi.mock("../../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => h.query(sql, p) } }));
import { advanceWhenClientItemsDone } from "../clientItemsDoneAdvance.js";

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string) => {
    if (/FROM application_packages/.test(sql)) return { rows: [{ n: h.sent }] };
    if (/UPDATE applications SET pipeline_state/.test(sql)) return { rows: h.state === "Additional Steps Required" ? [{ id: "a1" }] : [] };
    return { rows: [] };
  });
  h.sent = 0;
  h.state = "Additional Steps Required";
});
const calls = (re: RegExp) => h.query.mock.calls.filter((c) => re.test(String(c[0])));

describe("v808 Additional Steps moves on when the client is done", () => {
  it("goes to In Review, and records why", async () => {
    expect(await advanceWhenClientItemsDone("a1", 0, "done")).toBe("In Review");
    expect(String(calls(/UPDATE applications/)[0]?.[0])).toContain("pipeline_state = 'Additional Steps Required'");
    expect(calls(/INSERT INTO application_stage_events/)[0]?.[1]).toEqual(["a1", "In Review", "done"]);
  });
  it("goes back to Off to Lender when a package was already sent", async () => {
    h.sent = 1;
    expect(await advanceWhenClientItemsDone("a1", 0, "done")).toBe("Off to Lender");
  });
  it("does nothing while items are outstanding, or in any other stage", async () => {
    expect(await advanceWhenClientItemsDone("a1", 2, "done")).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
    h.state = "In Review";
    expect(await advanceWhenClientItemsDone("a1", 0, "done")).toBeNull();
    expect(calls(/INSERT INTO application_stage_events/)).toHaveLength(0);
  });
  it("persists history when the event id is required and has no default", async () => {
    const db = newDb();
    db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: randomUUID });
    db.public.none(`
      CREATE TABLE applications (id text PRIMARY KEY, pipeline_state text, updated_at timestamptz);
      CREATE TABLE application_packages (application_id text, sent_at timestamptz);
      CREATE TABLE application_stage_events (
        id uuid PRIMARY KEY, application_id text NOT NULL, from_stage text, to_stage text NOT NULL,
        trigger text NOT NULL, triggered_by text NOT NULL, reason text, created_at timestamptz NOT NULL
      );
      INSERT INTO applications (id, pipeline_state) VALUES ('a1', 'Additional Steps Required');
    `);
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    h.query.mockImplementation((sql: string, params?: unknown[]) => pool.query(sql, params));
    expect(await advanceWhenClientItemsDone("a1", 0, "done")).toBe("In Review");
    const { rows } = await pool.query("SELECT * FROM application_stage_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ application_id: "a1", to_stage: "In Review", trigger: "auto", triggered_by: "system", reason: "done" });
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await pool.end();
  });
});
