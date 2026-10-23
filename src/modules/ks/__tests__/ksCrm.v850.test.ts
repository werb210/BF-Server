// BF_SERVER_v850_KS_CRM - the KS-Ops ingest and the Keystone pipeline, with the database faked by SQL content.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: h.release }) },
  dbQuery: h.query,
}));
vi.mock("../../../modules/automation/automationEngine.js", async () => ({
  ...(await vi.importActual<any>("../../../modules/automation/automationEngine.js")),
  emitAutomationEvent: async () => undefined,
}));

import { nextAutoStage, parseKsUpsert, canUseKsCrm } from "../ksCrm.js";

const KEY = "k".repeat(40);
const CONTACT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";

async function app() {
  return mountRouter((await import("../../../routes/ksCrm.js")).default, "/api/ks/crm");
}

function db(rules: SqlRule[]) {
  h.query.mockImplementation(answerBySql([
    ...rules, // the test's own answers win
    [/INSERT INTO ks_crm_timeline_keys/, (_s: string, p?: unknown[]) => ({ rows: [{ dedupe_key: p?.[0] }] })],
    [/INSERT INTO crm_notes/, { rows: [{ id: "33333333-3333-4333-8333-333333333333" }] }],
  ]));
}

const upsert = async (body: unknown, key: string | null = KEY) => {
  const r = request(await app()).post("/api/ks/crm/upsert");
  if (key !== null) r.set("X-KS-Ops-Key", key);
  return r.send(body as object);
};

beforeEach(() => {
  h.query.mockReset();
  h.release.mockReset();
  process.env.KS_OPS_CRM_KEY = KEY;
  db([]);
});
afterEach(() => {
  delete process.env.KS_OPS_CRM_KEY;
  vi.restoreAllMocks();
});

describe("stage rules", () => {
  it("moves forward only and never out of lost", () => {
    expect(nextAutoStage(null, undefined)).toBe("lead");
    expect(nextAutoStage(null, "demo_started")).toBe("demo_started");
    expect(nextAutoStage("demo_finished", "demo_started")).toBe("demo_finished");
    expect(nextAutoStage("signed_up", "paying")).toBe("paying");
    expect(nextAutoStage("lost", "paying")).toBe("lost");
    // KS-Ops cannot set lost: that is a staff decision.
    expect(nextAutoStage("demo_started", "lost")).toBe("demo_started");
  });

  it("KS access is Admins and staff whose silo access includes KS", () => {
    expect(canUseKsCrm({ role: "Admin" })).toBe(true);
    expect(canUseKsCrm({ role: "Marketing", silos: ["BF", "KS"] })).toBe(true);
    expect(canUseKsCrm({ role: "Staff", silos: ["BF", "BI"] })).toBe(false);
    expect(canUseKsCrm(null)).toBe(false);
  });
});

describe("validation", () => {
  it("accepts the documented body", () => {
    const out = parseKsUpsert({
      source: "demo_signup", external_id: "d-1", stage: "demo_started",
      contact: { name: "Ada Lovelace", email: "ADA@Example.com", phone: "+14035550123", title: null },
      company: null, note: "Asked about seats",
      events: [{ type: "demo_step", at: "2026-10-23T10:00:00Z", summary: "Step 2" }],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.contact?.email).toBe("ada@example.com");
      expect(out.value.events[0]!.at).toBe("2026-10-23T10:00:00.000Z");
    }
  });

  it("names every bad field", () => {
    const out = parseKsUpsert({ source: "x", external_id: "", stage: "won", contact: { email: "nope" }, events: [{ type: "bad", at: "now" }] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["contact.email", "events.0.type", "external_id", "source", "stage"]);
    const many = parseKsUpsert({ source: "licensee", external_id: "l-1", events: Array.from({ length: 51 }, () => ({ type: "payment", at: "2026-10-23T10:00:00Z" })) });
    expect(many.ok).toBe(false);
    const long = parseKsUpsert({ source: "licensee", external_id: "x".repeat(101) });
    expect(long.ok).toBe(false);
  });
});

describe("POST /api/ks/crm/upsert", () => {
  const body = {
    source: "demo_signup", external_id: "demo-42", stage: "demo_started",
    contact: { name: "Ada Lovelace", email: "ada@example.com", phone: "+14035550123", title: null },
    events: [{ type: "demo_opened", at: "2026-10-23T10:00:00Z", summary: "Opened the demo" }],
  };

  it("is off (503) until KS_OPS_CRM_KEY is set, and a short key does not count", async () => {
    delete process.env.KS_OPS_CRM_KEY;
    expect((await upsert(body)).body).toEqual({ error: "ks_crm_not_configured" });
    process.env.KS_OPS_CRM_KEY = "short";
    const res = await upsert(body, "short");
    expect(res.status).toBe(503);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong key (401) before touching the database", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await upsert(body, null)).status).toBe(401);
    const res = await upsert(body, KEY.slice(0, -1) + "x");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_ops_key" });
    expect(h.query).not.toHaveBeenCalled();
  });

  it("400s bad input with the field errors", async () => {
    const res = await upsert({ source: "demo_signup" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.errors.external_id).toBeTruthy();
  });

  it("creates a KS contact at the incoming stage, stores the reference and writes the event once", async () => {
    db([[/INSERT INTO contacts/, { rows: [{ id: CONTACT, silo: "KS" }] }]]);
    const res = await upsert(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contact_id: CONTACT, company_id: null, stage: "demo_started" });
    const [ins] = callsMatching(h.query, /INSERT INTO contacts/);
    expect(ins[1]).toContain("KS");
    expect(ins[1]).toContain("ada@example.com");
    const [stage] = callsMatching(h.query, /UPDATE contacts SET ks_stage = \$2/);
    expect(stage[1]).toEqual([CONTACT, "demo_started"]);
    const [ref] = callsMatching(h.query, /INSERT INTO ks_crm_refs/);
    expect((ref[1] as unknown[]).slice(0, 4)).toEqual(["demo_signup", "demo-42", CONTACT, null]);
    const notes = callsMatching(h.query, /INSERT INTO crm_notes/);
    expect(notes).toHaveLength(1);
    expect(String(notes[0][0])).toContain("'KS'");
    expect(callsMatching(h.query, "COMMIT")).toHaveLength(1);
    expect(h.release).toHaveBeenCalled();
  });

  it("matches within KS by email and never moves a stage backwards or out of lost", async () => {
    db([
      [/FROM contacts\s+WHERE silo = 'KS' AND lower\(email\)/, { rows: [{ id: CONTACT, ks_stage: "paying" }] }],
    ]);
    const res = await upsert({ ...body, stage: "demo_finished" });
    expect(res.body.stage).toBe("paying");
    expect(callsMatching(h.query, /UPDATE contacts SET ks_stage/)).toHaveLength(0);
    expect(callsMatching(h.query, /INSERT INTO contacts/)).toHaveLength(0);

    h.query.mockClear();
    db([[/FROM contacts\s+WHERE silo = 'KS' AND lower\(email\)/, { rows: [{ id: CONTACT, ks_stage: "lost" }] }]]);
    expect((await upsert({ ...body, stage: "paying" })).body.stage).toBe("lost");
    expect(callsMatching(h.query, /UPDATE contacts SET ks_stage/)).toHaveLength(0);
  });

  it("falls back to the phone (last 10 digits) and matches companies by company_code", async () => {
    db([
      [/right\(regexp_replace\(coalesce\(phone/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "4035550123" ? [{ id: CONTACT, ks_stage: "lead" }] : [] })],
      [/lower\(ks_company_code\) = lower\(\$1\)/, { rows: [{ id: COMPANY, ks_stage: "signed_up" }] }],
    ]);
    const res = await upsert({
      source: "licensee", external_id: "lic-7", stage: "paying",
      contact: { name: "Ada", email: null, phone: "(403) 555-0123" },
      company: { name: "Acme Roofing", company_code: "ACME", plan: "pro", seats: 5, status: "active" },
    });
    expect(res.body).toEqual({ ok: true, contact_id: CONTACT, company_id: COMPANY, stage: "paying" });
    const [link] = callsMatching(h.query, /UPDATE contacts SET company_id = \$2::uuid/);
    expect(link[1]).toEqual([CONTACT, COMPANY]);
    const [co] = callsMatching(h.query, /UPDATE companies\s+SET name = coalesce/);
    expect(co[1]).toEqual([COMPANY, "Acme Roofing", null, "ACME", "pro", 5, "active"]);
    expect(callsMatching(h.query, /UPDATE companies SET ks_stage = \$2/)[0][1]).toEqual([COMPANY, "paying"]);
  });

  it("a repeat push hits the stored reference and adds nothing twice", async () => {
    db([
      [/FROM ks_crm_refs WHERE source = \$1 AND external_id = \$2/, { rows: [{ contact_id: CONTACT, company_id: null }] }],
      [/WHERE c.id = \$1 AND c.silo = 'KS'/, { rows: [{ id: CONTACT, ks_stage: "demo_started" }] }],
      [/INSERT INTO ks_crm_timeline_keys/, { rows: [] }],
    ]);
    const res = await upsert({ ...body, contact: { name: "Ada Lovelace", email: "ada.new@example.com", phone: null }, note: "Same note" });
    expect(res.status).toBe(200);
    expect(res.body.contact_id).toBe(CONTACT);
    expect(callsMatching(h.query, /INSERT INTO contacts/)).toHaveLength(0);
    expect(callsMatching(h.query, /INSERT INTO crm_notes/)).toHaveLength(0);
    // The new email is written onto the same contact.
    expect(callsMatching(h.query, /UPDATE contacts\s+SET name = coalesce/)[0][1]).toContain("ada.new@example.com");
  });

  it("rolls back and returns 500 (not a half-write) when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db([[/INSERT INTO ks_crm_refs/, new Error("db down")]]);
    const res = await upsert(body);
    expect(res.status).toBe(500);
    expect(callsMatching(h.query, "ROLLBACK")).toHaveLength(1);
    expect(h.release).toHaveBeenCalled();
  });
});

describe("Keystone pipeline (staff)", () => {
  const users = (role: string, silos: string[]): SqlRule => [/FROM users WHERE id = \$1/, { rows: [{ id: STAFF_USER_ID, role, silo: "BF", silos }] }];

  it("is refused to staff without KS access", async () => {
    db([users("Staff", ["BF", "BI"])]);
    const res = await request(await app()).get("/api/ks/crm/pipeline").set("Authorization", `Bearer ${staffToken("Staff")}`);
    expect(res.status).toBe(403);
  });

  it("lists cards and stages for an Admin", async () => {
    db([
      users("Admin", []),
      [/WITH demo AS/, { rows: [{ kind: "company", id: COMPANY, stage: "signed_up", company_id: COMPANY, company_name: "Acme", contact_id: CONTACT, contact_name: "Ada", plan: "pro", seats: 5, demo_steps: 3 }] }],
    ]);
    const res = await request(await app()).get("/api/ks/crm/pipeline").set("Authorization", `Bearer ${staffToken("Admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s: any) => s.key)).toEqual(["lead", "demo_started", "demo_finished", "signed_up", "paying", "lost"]);
    expect(res.body.cards[0]).toMatchObject({ kind: "company", stage: "signed_up", seats: 5, demo_steps: 3, silo: "KS" });
    const [q] = callsMatching(h.query, /WITH demo AS/);
    expect(String(q[0])).toContain("co.silo = 'KS'");
    expect(String(q[0])).toContain("c.silo = 'KS' AND c.company_id IS NULL");
  });

  it("staff can move a card to any stage, lost included, and the move is noted on the timeline", async () => {
    db([users("Admin", []), [/SELECT ks_stage FROM contacts WHERE id = \$1 AND silo = 'KS'/, { rows: [{ ks_stage: "paying" }] }]]);
    const res = await request(await app()).patch("/api/ks/crm/pipeline/stage").set("Authorization", `Bearer ${staffToken("Admin")}`)
      .send({ kind: "contact", id: CONTACT, stage: "lost" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stage: "lost", previous: "paying" });
    expect(callsMatching(h.query, /UPDATE contacts SET ks_stage = \$2/)[0][1]).toEqual([CONTACT, "lost"]);
    expect(String(callsMatching(h.query, /INSERT INTO crm_notes/)[0][1])).toContain("Paying -> Lost");
  });

  it("404s a record outside KS and 400s a bad stage", async () => {
    db([users("Admin", [])]);
    const auth = `Bearer ${staffToken("Admin")}`;
    expect((await request(await app()).patch("/api/ks/crm/pipeline/stage").set("Authorization", auth).send({ kind: "company", id: COMPANY, stage: "paying" })).status).toBe(404);
    expect((await request(await app()).patch("/api/ks/crm/pipeline/stage").set("Authorization", auth).send({ kind: "company", id: COMPANY, stage: "won" })).status).toBe(400);
  });
});
