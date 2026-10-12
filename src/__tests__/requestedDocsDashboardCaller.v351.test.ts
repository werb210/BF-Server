// BF_SERVER_REQUESTED_DOCS_v351 / BF_SERVER_CALLER_COLUMNS_v351 / BF_SERVER_DASHBOARD_LEGS_v351
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), sendViaGraph: vi.fn(async () => ({ ok: true, messageId: "m1" })) }));
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: h.queryMock, connect: vi.fn(async () => ({ query: h.queryMock, release: vi.fn() })) },
    runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock,
  };
});
vi.mock("../signnow/sba/sbaTrigger.js", async (orig) => ({
  ...(await orig<typeof import("../signnow/sba/sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => false),
}));
vi.mock("../services/documentSharing.js", () => ({ shareFromOtherApplications: vi.fn(async () => 0), sharedDocumentsFor: vi.fn(async () => []) }));
vi.mock("../voice/conferenceService.js", async (orig) => ({
  ...(await orig<typeof import("../voice/conferenceService.js")>()),
  createConference: vi.fn(async () => ({ id: "conf-1", friendly_name: "mp_conf" })),
  addParticipantRow: vi.fn(async () => "pid-1"),
  setParticipantCallSid: vi.fn(async () => undefined),
  dialClientIntoConference: vi.fn(async () => undefined),
  broadcastIncomingRing: vi.fn(async () => undefined),
}));
vi.mock("../services/clientEmail.js", () => ({ resolveClientEmail: vi.fn(async () => ({ email: "jane@example.com", firstName: "Jane" })), crmContactEmail: vi.fn(async () => null) }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: h.sendViaGraph }));

const read = (p: string) => fs.readFileSync(p, "utf8");
const mig = read("migrations/2026_09_18_v351_application_document_requests.sql");

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a1";
const sign = (sub: string, role: string) => jwt.sign({ sub, role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function mount(path: string, modPath: string, form = false) {
  const router = (await import(modPath)).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  if (form) app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { h.queryMock.mockReset(); h.queryMock.mockImplementation(answerBySql([])); h.sendViaGraph.mockClear(); });

describe("requested documents are stored and required", () => {
  it("has an idempotent table", () => { expect(mig).toContain("CREATE TABLE IF NOT EXISTS application_document_requests"); expect(mig).toContain("CREATE UNIQUE INDEX IF NOT EXISTS application_document_requests_app_type_uq"); });

  it("Request from Client writes each document and lifts a matching waiver", async () => {
    h.queryMock.mockImplementation(answerBySql([[/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }]]));
    const app = await mount("/api/applications", "../modules/applications/applications.routes.js");
    const res = await request(app).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`).send({ documents: ["Void cheque", "Void cheque", "Articles of incorporation"] });
    expect(res.status).toBe(200);
    const inserts = callsMatching(h.queryMock, /INSERT INTO application_document_requests/);
    expect(inserts.map((c) => (c[1] as unknown[])[1])).toEqual(["Void cheque", "Articles of incorporation"]);
    expect(sqlText(inserts[0]![0])).toContain("INSERT INTO application_document_requests (application_id, document_type, requested_by)");
    expect(sqlText(inserts[0]![0])).toContain("ON CONFLICT (application_id, document_type) DO NOTHING");
    expect(inserts[0]![1]).toEqual([APP_ID, "Void cheque", STAFF_ID]);
    const lifts = callsMatching(h.queryMock, /DELETE FROM application_document_waivers/);
    expect(lifts.map((c) => c[1])).toEqual([[APP_ID, "Void cheque"], [APP_ID, "Articles of incorporation"]]);
  });

  it("the required set includes them, so the client's upload task stays open", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/SELECT metadata FROM applications/, { rows: [{ metadata: { productRequirements: { aggregated: [{ document_type: "Business plan", required: true }] } } }] }],
      // lease_or_loi is otherwise always optional; asking for it makes it blocking. "business plan" dedupes.
      [/FROM application_document_requests/, { rows: [{ document_type: "lease_or_loi" }, { document_type: "business plan" }, { document_type: "Void cheque" }] }],
    ]));
    const { computeOutstandingDocs } = await import("../routes/clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    expect(out.required.map((d) => d.document_type)).toEqual(["Business plan", "lease_or_loi", "Void cheque"]);
    expect(out.stillNeeded.map((d) => d.document_type)).toEqual(["Business plan", "lease_or_loi", "Void cheque"]);
    expect(out.required.find((d) => d.document_type === "lease_or_loi")?.required).toBe(true);
  });

  it("a requested document already uploaded is no longer outstanding", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/WITH fam AS/, { rows: [{ category: "Void cheque", status: "accepted" }] }],
      [/FROM application_document_requests/, { rows: [{ document_type: "Void cheque" }] }],
    ]));
    const { computeOutstandingDocs } = await import("../routes/clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    expect(out.required.map((d) => d.document_type)).toEqual(["Void cheque"]);
    expect(out.stillNeeded).toEqual([]);
  });
});

describe("caller lookups read columns that exist", () => {
  const FORBIDDEN = [/(SELECT|,)\s*c\.full_name\b/, /a\.business_name\b/, /a\.company_name\b/, /SELECT business_name FROM applications/];
  const assertRealColumns = () => {
    expect(h.queryMock.mock.calls.length).toBeGreaterThan(0);
    for (const [sql] of h.queryMock.mock.calls) for (const bad of FORBIDDEN) expect(sqlText(sql)).not.toMatch(bad);
  };

  it("voice: Call Us! caller (resolve-caller) and recents", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/FROM applications a\s+LEFT JOIN contacts c ON c\.id = a\.contact_id/, { rows: [{ contact_id: "c1", full_name: "Jane Roe", phone: "+15875550142", application_id: APP_ID, business_name: "Acme" }] }],
    ]));
    const app = await mount("/api/voice", "../routes/voiceCalls.js");
    const res = await request(app).post("/api/voice/resolve-caller").set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`).send({ phone: `client:client-${APP_ID}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: true, name: "Jane Roe", companyName: "Acme", applicationId: APP_ID });
    const [lookup] = callsMatching(h.queryMock, /FROM applications a\s+LEFT JOIN contacts c/)[0]!;
    // A placeholder contact name is replaced by the person's own name.
    expect(sqlText(lookup)).toContain("c.name ILIKE '%(application started)%'");

    const recents = await request(app).get("/api/voice/recent-calls").set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`);
    expect(recents.status).toBe(200);
    const [recentSql] = callsMatching(h.queryMock, /FROM call_logs cl/)[0]!;
    expect(sqlText(recentSql)).toContain("c.name ILIKE '%(application started)%'");
    expect(sqlText(recentSql)).toContain("FROM applications ap WHERE ap.id::text = cl.application_id::text");
    assertRealColumns();
  });

  it("voice webhook: mini-portal caller", async () => {
    const auth = String(process.env.TWILIO_AUTH_TOKEN);
    h.queryMock.mockImplementation(answerBySql([
      [/FROM staff_presence/, { rows: [{ user_id: STAFF_ID, twilio_identity: "staff-1" }] }],
      [/FROM applications a\s+LEFT JOIN contacts c/, { rows: [{ full_name: "Jane Roe", business_name: "Acme", phone: "+15875550142" }] }],
    ]));
    const app = await mount("/api/webhooks", "../routes/webhooks.js", true);
    const path = "/api/webhooks/twilio/voice/twiml";
    const params = { From: `client:client-${APP_ID}`, CallSid: "CA0123456789abcdef0123456789abcdef" };
    const res = await request(app).post(path).type("form")
      .set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(auth, `https://example.com${path}`, params))
      .send(params);
    expect(res.status).toBe(200);
    const [sql, p] = callsMatching(h.queryMock, /FROM applications a\s+LEFT JOIN contacts c/)[0]!;
    expect(p).toEqual([APP_ID]);
    expect(sqlText(sql)).toContain("c.name ILIKE '%(application started)%'");
    assertRealColumns();
  });

  it("caller display for an applicant", async () => {
    const db = { query: vi.fn(answerBySql([[/FROM applications a LEFT JOIN contacts c/, { rows: [{ first_name: null, last_name: null, company_name: "Acme" }] }]])) };
    const { resolveDisplayName } = await import("../modules/voice/callerDisplay.js");
    expect(await resolveDisplayName(db, `client-${APP_ID}`)).toBe("Acme");
    h.queryMock.mock.calls.push(...db.query.mock.calls);
    assertRealColumns();
  });

  it("sequence enrolment report", async () => {
    const pool = { query: vi.fn(answerBySql([[/FROM marketing_sequences/, { rows: [{ silo: "BF" }] }]])) };
    const { enrollContactsDetailed } = await import("../services/sequenceEngine.js");
    await enrollContactsDetailed(pool as any, "seq-1", ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    const [sql] = callsMatching(pool.query, /FROM contacts c WHERE c\.id = ANY/)[0]!;
    expect(sqlText(sql)).toContain("c.name AS full_name");
    h.queryMock.mock.calls.push(...pool.query.mock.calls);
    assertRealColumns();
  });

  it("rejection notice", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/SET rejection_email_sent_at = NOW\(\)/, { rows: [{ already: APP_ID }] }],
      [/AS business_name FROM applications/, { rows: [{ business_name: "Acme" }] }],
      [/FROM application_rejection_reasons arr/, { rows: [{ code: "tib", label: "Time in business", why_it_matters: "Lenders want two years.", what_helps: null }] }],
    ]));
    const { sendRejectionNoticeToClient } = await import("../services/rejectionNotice.js");
    expect(await sendRejectionNoticeToClient(APP_ID)).toEqual({ sent: true });
    expect(String((h.sendViaGraph.mock.calls[0] as unknown as [any])[0].bodyText)).toContain("for Acme");
    assertRealColumns();
  });
});

describe("dashboard commission", () => {
  const metrics = async (role: "Admin" | "Staff" = "Admin") => {
    h.queryMock.mockImplementation(answerBySql([
      [/AS native/, { rows: [
        { stage: "Accepted", currency: "USD", native: "1000", cad: "1370" },
        { stage: "Accepted", currency: "CAD", native: "500", cad: "500" },
        { stage: "Offer", currency: "CAD", native: "200", cad: "200" },
      ] }],
    ]));
    const app = await mount("/api/dashboard", "../routes/dashboard.js");
    const res = await request(app).get("/api/dashboard/metrics").set("Authorization", `Bearer ${sign(role === "Admin" ? ADMIN_ID : STAFF_ID, role)}`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it("counts equipment legs and excludes rejected deals from commission", async () => {
    await metrics();
    const [sql] = callsMatching(h.queryMock, /AS native/)[0]!;
    expect(sqlText(sql)).not.toContain("parent_application_id IS NULL  -- v829");
    expect(sqlText(sql)).toContain("source IN ('closing_costs_companion', 'capital_and_equipment_leg')");
    expect(sqlText(sql)).toContain("NOT IN ('draft', 'Draft', '', 'Rejected')");
  });

  it("reports native amounts per currency", async () => {
    const d = await metrics();
    expect(d.commissionByStageCurrency).toEqual({ Accepted: { USD: 1000, CAD: 500 }, Offer: { CAD: 200 } });
    expect(d.commissionEarnedByCurrency).toEqual({ USD: 1000, CAD: 500 });
    expect(d.commissionEarned).toBe(1870);
    const { DEAL_CURRENCY_SQL } = await import("../routes/dashboard.js");
    expect(DEAL_CURRENCY_SQL).toContain("THEN 'USD'");
    const [sql] = callsMatching(h.queryMock, /AS native/)[0]!;
    expect(sqlText(sql)).toContain("THEN 'USD'");
  });

  it("keeps the money from non-admin staff", async () => {
    const d = await metrics("Staff");
    expect(d.commissionByStageCurrency).toEqual({});
    expect(d.commissionEarnedByCurrency).toEqual({});
  });
});
