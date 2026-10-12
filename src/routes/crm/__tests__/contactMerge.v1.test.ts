// BF_SERVER_CONTACT_MERGE_v1
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: h.release }) },
  dbQuery: h.query,
}));

const SURVIVOR = "11111111-0000-4000-8000-000000000001";
const LOSER = "22222222-0000-4000-8000-000000000002";
const LOSER_ROW = { id: LOSER, email: "old@ex.com", phone: "4035550100", first_name: "Mike", last_name: "Cotic", tags: ["vip"], status: "active" };

function mergeRules(survivor: Record<string, unknown> = { id: SURVIVOR, status: "active", merged_into_id: null }): SqlRule[] {
  return [
    [/FROM information_schema\.columns/, { rows: [{ table_name: "applications" }, { table_name: "marketing_sequence_enrollments" }] }],
    [/FROM pg_index/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "marketing_sequence_enrollments" ? [{ cols: "{sequence_id,contact_id}", pred: "true" }] : [] })],
    [/SELECT \* FROM contacts WHERE id = \$1::uuid AND silo = \$2 FOR UPDATE/, (_s: string, p?: unknown[]) => ({ rowCount: 1, rows: [p?.[0] === SURVIVOR ? survivor : LOSER_ROW] })],
    [/^UPDATE "applications" SET contact_id/, { rowCount: 3, rows: [] }],
    [/UPDATE call_logs SET crm_contact_id/, { rowCount: 2, rows: [] }],
  ];
}

async function app() {
  return mountRouter((await import("../../crm.js")).default, "/api/crm");
}
const auth = () => ({ Authorization: `Bearer ${staffToken()}` });
const merge = async (body: Record<string, unknown>) => request(await app()).post("/api/crm/contacts/merge").set(auth()).send(body);
const statements = () => h.query.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql(mergeRules()));
  h.release.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("contact merge", () => {
  it("is mounted under the CRM contacts routes", async () => {
    const res = await request(await app()).get(`/api/crm/contacts/${SURVIVOR}/duplicate-candidates`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it("finds duplicates by NAME, not just exact email/phone, without pg_trgm", async () => {
    // Mike Cotic, Juergen Zischler and Wayne Beamish all differ on BOTH email and phone.
    // Without a name match the tool cannot see a single real duplicate in this database.
    h.query.mockImplementation(answerBySql([[/WITH me AS/, { rows: [{ id: LOSER, name: "MICHAEL COTIC", match_name: true }] }]]));
    const res = await request(await app()).get(`/api/crm/contacts/${SURVIVOR}/duplicate-candidates`).set(auth()).set("X-Silo", "BF");
    expect(res.body.data).toEqual([{ id: LOSER, name: "MICHAEL COTIC", match_name: true }]);
    const [call] = callsMatching(h.query, /WITH me AS/);
    expect(String(call[0])).toContain("bf_same_person_name(c.name, me.name)");
    expect(String(call[0])).not.toContain("similarity(lower(");
    expect(call[1]).toEqual([SURVIVOR, "BF"]);
  });

  it("the name matcher is a plain SQL function; the migration creates no extension", () => {
    // Creating pg_trgm threw on Azure, and the fatal migration runner crash-looped the app.
    const mig = readFileSync(path.join(process.cwd(), "migrations/2026_07_13_contact_merge.sql"), "utf8");
    expect(mig).not.toContain("CREATE EXTENSION");
    expect(mig).toContain("bf_same_person_name");
  });

  it("repoints EVERY table with a contact_id, discovered at runtime", async () => {
    const res = await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    expect(res.status).toBe(200);
    expect(String(callsMatching(h.query, /information_schema\.columns/)[0][0])).toContain("column_name = 'contact_id'");
    for (const t of ["applications", "marketing_sequence_enrollments"]) {
      const [up] = callsMatching(h.query, new RegExp(`^UPDATE "${t}" SET contact_id = \\$1::uuid WHERE contact_id = \\$2::uuid`));
      expect(up?.[1], t).toEqual([SURVIVOR, LOSER]);
    }
    expect(res.body.data.moved).toMatchObject({ applications: 3 });
  });

  it("drops a loser row that would collide on a UNIQUE index before repointing", async () => {
    await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    const s = statements();
    const del = s.findIndex((x) => x.includes('DELETE FROM "marketing_sequence_enrollments" l'));
    const up = s.findIndex((x) => x.startsWith('UPDATE "marketing_sequence_enrollments" SET contact_id'));
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(up);
  });

  it("also repoints call_logs, which uses crm_contact_id and would otherwise be missed", async () => {
    const res = await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    expect(callsMatching(h.query, /UPDATE call_logs SET crm_contact_id/)[0][1]).toEqual([SURVIVOR, LOSER]);
    expect(res.body.data.moved.call_logs).toBe(2);
  });

  it("never destroys data the loser uniquely had", async () => {
    await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    const [fill] = callsMatching(h.query, /UPDATE contacts s SET\s+email/);
    expect(String(fill[0])).toContain("coalesce(nullif(trim(s.email),''), nullif(trim($2),''))");
    expect(String(fill[0])).toContain("array_agg(DISTINCT x)"); // tags are unioned, not replaced
    expect((fill[1] as unknown[]).slice(0, 5)).toEqual([SURVIVOR, "old@ex.com", "4035550100", "Mike", "Cotic"]);
    expect((fill[1] as unknown[])[11]).toEqual(["vip"]);
  });

  it("refuses to merge INTO an archived or already-merged contact (prevents circular A<->B merges)", async () => {
    for (const survivor of [{ id: SURVIVOR, status: "archived" }, { id: SURVIVOR, status: "active", merged_into_id: LOSER }]) {
      h.query.mockReset().mockImplementation(answerBySql(mergeRules(survivor)));
      const res = await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("cannot merge into an archived or already-merged contact");
      expect(statements()).toContain("ROLLBACK");
      expect(callsMatching(h.query, /SET merged_into_id/)).toHaveLength(0);
    }
  });

  it("is transactional and reversible", async () => {
    await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    const s = statements();
    const begin = s.indexOf("BEGIN");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(s.findIndex((x) => x.includes("SET merged_into_id")));
    expect(s.at(-1)).toBe("COMMIT");
    const [snap] = callsMatching(h.query, /INSERT INTO contact_merges/);
    expect(String(snap[0])).toContain("loser_snapshot");
    expect(JSON.parse(String((snap[1] as unknown[])[4])).contact).toEqual(LOSER_ROW);
    expect(h.release).toHaveBeenCalled();

    // A failure part-way rolls everything back.
    h.query.mockReset().mockImplementation(answerBySql([[/UPDATE call_logs/, new Error("boom")], ...mergeRules()]));
    const res = await merge({ survivorId: SURVIVOR, loserIds: [LOSER] });
    expect(res.status).toBe(500);
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
  });

  it("supports a dry run so staff can see what would move before committing", async () => {
    const res = await merge({ survivorId: SURVIVOR, loserIds: [LOSER], dryRun: true });
    expect(res.body.data).toMatchObject({ dryRun: true, wouldMove: { applications: 3, call_logs: 2 } });
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
  });

  it("refuses to merge a contact into itself", async () => {
    const res = await merge({ survivorId: SURVIVOR, loserIds: [SURVIVOR] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("a contact cannot be merged into itself");
    expect(statements()).not.toContain("BEGIN");
  });
});
