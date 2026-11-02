// BF_SERVER_v869_SETTINGS_PACK_PRIVACY - cookie consent records and privacy requests (access, correction, deletion with the
// 7-year retention and legal holds respected). The database fake answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query, connect: async () => ({ query: h.tx, release: () => undefined }) }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { explainKept, parseConsent, parseCorrection } from "../privacy.js";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = (id: string) => jwt.sign({ sub: id, id, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

let audits: Array<{ type: unknown; meta: any }>;
let reqRow: Record<string, unknown>;
let held: boolean;
let openFile: boolean;
function fake(extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === ADMIN ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push({ type: p?.[4], meta: JSON.parse(String(p?.[10] ?? "null")) }); return { rows: [] }; }],
    [/COALESCE\(NULLIF\(name, ''\), email, phone, 'Contact'\) AS label FROM contacts/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === CONTACT ? [{ label: "Jane Client" }] : [] })],
    [/INSERT INTO privacy_requests/, (_s: string, p?: unknown[]) => ({ rows: [{ id: REQ, contact_id: p?.[0], contact_label: p?.[1], kind: p?.[2], status: "open", due_at: "2026-12-01T00:00:00Z" }] })],
    [/FROM privacy_requests WHERE id::text = \$1/, () => ({ rows: [reqRow] })],
    [/UPDATE privacy_requests SET status = \$2/, (_s: string, p?: unknown[]) => ({ rows: [{ ...reqRow, status: p?.[1], outcome: JSON.parse(String(p?.[2])) }] })],
    [/FROM legal_holds h/, () => ({ rows: held ? [{ id: "h1", target_type: "contact", target_id: CONTACT, target_label: "Jane Client", reason: "Litigation", placed_at: new Date("2026-10-01") }] : [] })],
    [/FROM retention_applications/, () => ({ rows: openFile ? [{ application_id: "app-1", label: "Acme", is_record: true, closed_at: null, last_upload_at: new Date("2026-09-01") }] : [] })],
    [/SELECT \* FROM contacts WHERE id::text = \$1/, { rows: [{ id: CONTACT, name: "Jane Client", email: "jane@x.test", o365_refresh_token: "secret" }] }],
    [/SELECT \* FROM crm_notes WHERE contact_id::text = \$1/, { rows: [{ id: "n1", body: "Called Jane" }] }],
    [/SELECT \* FROM voicemails WHERE contact_id/, new Error("relation \"voicemails\" does not exist")],
    [/SELECT name, email FROM contacts/, { rows: [{ name: "Jane Client", email: "old@x.test" }] }],
  ]));
}
async function app() {
  const router = (await import("../../routes/privacy.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/privacy", router);
  return a;
}

beforeEach(() => {
  h.query.mockReset(); h.tx.mockReset();
  audits = []; held = false; openFile = false;
  reqRow = { id: REQ, contact_id: CONTACT, contact_label: "Jane Client", kind: "deletion", status: "open" };
  h.tx.mockImplementation(async (sql: string) => ({ rows: [], rowCount: /DELETE FROM crm_notes|DELETE FROM contacts/.test(sql) ? 1 : 0 }));
  fake();
});

describe("cookie consent", () => {
  it("parses and records a visitor's choice with a hashed IP, never the address", async () => {
    expect(parseConsent({ visitorId: "v_12345678", surface: "booking_page", choice: "denied" })).toEqual({
      ok: true, value: { visitorId: "v_12345678", surface: "booking_page", choice: "denied", categories: { analytics: false, session_replay: false, advertising: false }, policyVersion: null },
    });
    expect(parseConsent({ visitorId: "x", surface: "client_app", choice: "granted" }).ok).toBe(false);
    expect(parseConsent({ visitorId: "v_12345678", surface: "somewhere", choice: "granted" }).ok).toBe(false);
    const res = await request(await app()).post("/api/privacy/consent").set("X-Forwarded-For", "203.0.113.9")
      .send({ visitorId: "v_12345678", surface: "client_app", choice: "granted", categories: { session_replay: false } });
    expect(res.status).toBe(201);
    const [, p] = callsMatching(h.query, /INSERT INTO cookie_consents/)[0]!;
    expect(p![2]).toBe("granted");
    expect(JSON.parse(String(p![3]))).toEqual({ analytics: true, session_replay: false, advertising: true });
    expect(String(p![5])).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(p)).not.toContain("203.0.113.9");
  });
});

describe("privacy requests", () => {
  it("are Admin only", async () => {
    const res = await request(await app()).get("/api/privacy/requests").set("Authorization", `Bearer ${token(STAFF)}`);
    expect(res.status).toBe(403);
  });

  it("records a request against a contact, due in 30 days (audited)", async () => {
    const a = await app();
    const bad = await request(a).post("/api/privacy/requests").set("Authorization", `Bearer ${token(ADMIN)}`).send({ contact_id: "nope", kind: "erase" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.errors).sort()).toEqual(["contact_id", "kind"]);
    const ok = await request(a).post("/api/privacy/requests").set("Authorization", `Bearer ${token(ADMIN)}`).send({ contact_id: CONTACT, kind: "access", received_via: "email" });
    expect(ok.status).toBe(201);
    expect(ok.body.request).toMatchObject({ contact_label: "Jane Client", kind: "access" });
    expect(audits.map((x) => x.type)).toContain("privacy_request.created");
  });

  it("access: exports the contact's data without secrets, listing anything it could not read (audited)", async () => {
    reqRow = { ...reqRow, kind: "access" };
    const res = await request(await app()).get(`/api/privacy/requests/${REQ}/export`).set("Authorization", `Bearer ${token(ADMIN)}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("export.json");
    expect(res.body.contact).toEqual({ id: CONTACT, name: "Jane Client", email: "jane@x.test" });
    expect(res.body.records.crm_notes).toEqual([{ id: "n1", body: "Called Jane" }]);
    expect(Object.keys(res.body.skipped)).toEqual(["voicemails"]);
    expect(audits.find((x) => x.type === "privacy_request.exported")?.meta.tables).toEqual(["crm_notes"]);
  });

  it("correction: validates, then records the old and new values", async () => {
    expect(parseCorrection({ email: "not-an-email" }).ok).toBe(false);
    reqRow = { ...reqRow, kind: "correction" };
    const res = await request(await app()).post(`/api/privacy/requests/${REQ}/correct`).set("Authorization", `Bearer ${token(ADMIN)}`)
      .send({ changes: { name: "Jane Client", email: "jane@new.test" } });
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([{ field: "name", from: "Jane Client", to: "Jane Client" }, { field: "email", from: "old@x.test", to: "jane@new.test" }]);
    expect(callsMatching(h.query, /UPDATE contacts SET name = \$2, email = \$3/)[0]![1]).toEqual([CONTACT, "Jane Client", "jane@new.test"]);
    expect(audits.find((x) => x.type === "privacy_request.corrected")).toBeTruthy();
  });

  it("deletion with nothing retained: removes the contact and its activity in one transaction (audited)", async () => {
    const preview = await request(await app()).get(`/api/privacy/requests/${REQ}`).set("Authorization", `Bearer ${token(ADMIN)}`);
    expect(preview.body.deletion_plan.can_delete).toBe(true);
    const res = await request(await app()).post(`/api/privacy/requests/${REQ}/delete`).set("Authorization", `Bearer ${token(ADMIN)}`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toMatchObject({ deleted: true, removed: { crm_notes: 1, contacts: 1 }, kept: [] });
    const sqls = h.tx.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls).toContain("COMMIT");
    expect(sqls.some((s) => /DELETE FROM contacts WHERE id::text = \$1/.test(s))).toBe(true);
    expect(audits.map((x) => x.type)).toContain("privacy_request.deletion_completed");
  });

  it("deletion under a legal hold keeps the records, opts the person out, and says what was kept and why", async () => {
    held = true;
    const res = await request(await app()).post(`/api/privacy/requests/${REQ}/delete`).set("Authorization", `Bearer ${token(ADMIN)}`);
    expect(res.body.outcome.deleted).toBe(false);
    expect(res.body.outcome.kept[0].why).toContain("Legal hold");
    expect(res.body.outcome.kept[0].why).toContain("Litigation");
    expect(res.body.outcome.suppressed).toEqual(["marketing email", "text messages"]);
    expect(h.tx).not.toHaveBeenCalled();
    expect(callsMatching(h.query, /UPDATE contacts SET marketing_opt_out = true, sms_opt_out = true, sms_consent = false/)).toHaveLength(1);
    expect(audits.map((x) => x.type)).toContain("privacy_request.deletion_limited");
  });

  it("deletion while a file is open keeps it under the 7-year retention", () => {
    const kept = explainKept({ locked: true, reason: "retention", deletable_on: null, earliest_deletable_on: null, file_open: true, holds: [], message: null } as any);
    expect(kept[0]!.why).toContain("7 years after it closes");
  });

  it("a refusal needs a reason; a closed request cannot be acted on again", async () => {
    const a = await app();
    const noReason = await request(a).post(`/api/privacy/requests/${REQ}/close`).set("Authorization", `Bearer ${token(ADMIN)}`).send({ status: "refused" });
    expect(noReason.status).toBe(400);
    const refused = await request(a).post(`/api/privacy/requests/${REQ}/close`).set("Authorization", `Bearer ${token(ADMIN)}`).send({ status: "refused", note: "Identity not confirmed" });
    expect(refused.body.request.status).toBe("refused");
    reqRow = { ...reqRow, status: "completed" };
    const again = await request(a).post(`/api/privacy/requests/${REQ}/delete`).set("Authorization", `Bearer ${token(ADMIN)}`);
    expect(again.status).toBe(409);
  });
});
