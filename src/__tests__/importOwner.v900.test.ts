// BF_SERVER_v900_IMPORT_OWNER - an Owner column assigns imported contacts to that staff member.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql } from "./helpers/answerBySql.js";
import { bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({ q: vi.fn() }));
vi.mock("../db.js", async (importOriginal) => {
  const real: any = await importOriginal();
  const query = (sql: unknown, params?: unknown[]) => h.q(sql, params);
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, runQuery: query, dbQuery: query, query };
});
vi.mock("../modules/automation/automationEngine.js", () => ({
  emitAutomationEvent: vi.fn(async () => undefined),
  runAutomations: vi.fn(async () => undefined),
  defaultDeps: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })) })),
  runDue: vi.fn(async () => 0),
  runEnrollment: vi.fn(async () => "completed"),
  buildContext: vi.fn(async () => ({})),
}));

const COLS = ["id", "first_name", "last_name", "name", "email", "phone", "company_name", "job_title", "lead_status", "silo", "owner_id", "updated_at"];

async function app() {
  const { default: crm } = await import("../routes/crm.js");
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crm);
  return a;
}

beforeEach(() => {
  h.q.mockReset();
  h.q.mockImplementation(answerBySql([
    [/FROM information_schema\.columns/, { rows: COLS.map((column_name) => ({ column_name })) }],
    [/SELECT id FROM users/, (_s: string, p?: unknown[]) => {
      const k = String(p?.[0]);
      return k === "andrew@example.test" || k === "andrew sample" ? { rows: [{ id: "u-andrew" }] } : { rows: [] };
    }],
    [/SELECT \* FROM contacts WHERE silo = \$1 AND lower\(email\) = lower\(\$2\)/, (_s: string, p?: unknown[]) =>
      String(p?.[1]) === "old@acme.test" ? { rows: [{ id: "ct-old", email: "old@acme.test", owner_id: "u-someone" }] } : { rows: [] }],
    [/INSERT INTO contacts/, { rows: [{ id: "ct-new" }] }],
  ]));
});

describe("contact import Owner column", () => {
  it("assigns by owner email or full name, overwrites on update, and reports unmatched owners", async () => {
    const res = await request(await app())
      .post("/api/crm/contacts/import")
      .set("Authorization", bearer("Admin"))
      .send({ rows: [
        { email: "new@acme.test", first_name: "New", last_name: "Person", owner: "Andrew@Example.test" },
        { email: "old@acme.test", first_name: "Old", owner: "Andrew Sample" },
        { email: "third@acme.test", first_name: "Third", owner: "Nobody Here" },
      ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 1, owners_unmatched: ["Nobody Here"] });
    const calls = h.q.mock.calls as Array<[string, unknown[]]>;
    const inserts = calls.filter(([s]) => /INSERT INTO contacts/.test(String(s)));
    expect(inserts[0]![1]).toContain("u-andrew");
    expect(inserts[1]![1]).not.toContain("u-andrew");
    const upd = calls.find(([s]) => /UPDATE contacts SET/.test(String(s)))!;
    expect(String(upd[0])).toMatch(/owner_id = \$\d+/);
    expect(String(upd[0])).not.toMatch(/COALESCE\(owner_id/);
    expect(upd[1]).toContain("u-andrew");
  });
});
