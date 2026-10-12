// BF_SERVER_BLOCK_v563 - PGI waits for a signed term sheet.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const PGI_URL = "https://bi.example/complete/abc";
const h = vi.hoisted(() => ({
  query: vi.fn(),
  signed: false,
  real: false,
  asked: [] as string[],
  pgiLinks: [] as string[],
  sms: vi.fn(async () => undefined),
}));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
// The callers' view of "is the term sheet signed": recorded and answered here; the
// service's own query is exercised with h.real = true.
vi.mock("../termSheetSigned.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    termSheetSigned: async (id: string) => (h.real ? real.termSheetSigned(id) : (h.asked.push(id), h.signed)),
    sendPgiLinkAfterTermSheet: async (id: string) => { h.pgiLinks.push(id); return "sent"; },
  };
});
vi.mock("../../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));
vi.mock("../biHandoff.js", async (orig) => ({ ...(await orig<any>()), postBiHandoff: async () => ({ ok: true, biApplicationId: "bi-1", biPublicId: "BI-1", completionUrl: "https://bi.example/complete/abc" }) }));
vi.mock("../biDocMirror.js", async (orig) => ({ ...(await orig<any>()), mirrorApplicationDocsToBi: async () => undefined, mirrorDocToBiAsync: () => undefined }));
vi.mock("../../modules/notifications/sms.service.js", async (orig) => ({ ...(await orig<any>()), sendSms: h.sms }));
vi.mock("../signnow/sendOfferTermSheet.js", async (orig) => ({ ...(await orig<any>()), attachSignedTermSheet: async () => ({ attached: true }) }));
vi.mock("../../modules/applications/applications.service.js", async (orig) => ({ ...(await orig<any>()), transitionPipelineState: async () => undefined }));
vi.mock("../notifications/notifyAllStaff.js", () => ({ notifyAllStaff: async () => undefined }));

const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const OWNERSHIP: SqlRule[] = [
  [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
  [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
];

beforeEach(() => {
  h.signed = false;
  h.real = false;
  h.asked.length = 0;
  h.pgiLinks.length = 0;
  h.sms.mockClear();
  h.query.mockReset();
  h.query.mockImplementation(answerBySql(OWNERSHIP));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("v563 PGI waits for a signed term sheet", () => {
  it("the client thread hides the PGI prompt until signed", async () => {
    h.query.mockImplementation(answerBySql([
      ...OWNERSHIP,
      [/WITH thread AS/, { rows: [
        { id: "pgi", direction: "outbound", body: "PGI", staff_name: "Boreal Insurance", cta_label: "Complete PGI Application", cta_action: PGI_URL, created_at: "2026-10-01T00:00:00Z" },
        { id: "chat", direction: "outbound", body: "Hello", staff_name: "Todd", cta_label: null, cta_action: null, created_at: "2026-10-01T00:01:00Z" },
      ] }],
    ]));
    const { default: clientRouter } = await import("../../routes/client/index.js");
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token);
    expect(r.status).toBe(200);
    expect(h.asked).toEqual([APP]);
    expect(r.body.data.map((m: any) => m.id)).toEqual(["chat"]);
  }, 30_000);

  it("the submit-time SMS with the PGI link waits too", async () => {
    h.query.mockImplementation(answerBySql([
      ...OWNERSHIP,
      [/SELECT id, silo, owner_user_id\s+FROM applications/, { rows: [{ id: APP, silo: "BF", owner_user_id: null }] }],
      [/SELECT c\.phone\s+FROM applications a\s+LEFT JOIN contacts c/, { rows: [{ phone: "+14035230100" }] }],
    ]));
    const { default: v1 } = await import("../../routes/client/v1Applications.js");
    const app = express();
    app.use(express.json());
    app.use("/api/client", v1);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status ?? 500).json({ error: err?.message }));
    const submit = () => request(app).post(`/api/client/applications/${APP}/submit`).set("Authorization", token)
      .send({ app: { pgi_opt_in: "yes", business: { companyName: "Acme" }, applicant: { phone: "+14035230100" } } });

    await submit();
    expect(h.asked).toContain(APP);
    // The PGI prompt is posted to the thread, but no text goes out before the term sheet is signed.
    expect(callsMatching(h.query, "INSERT INTO communications_messages").some((c) => (c[1] as unknown[]).includes(PGI_URL))).toBe(true);
    expect(h.sms).not.toHaveBeenCalled();

    h.signed = true;
    await submit();
    expect(h.sms).toHaveBeenCalledWith(expect.objectContaining({ to: "+14035230100", message: expect.stringContaining(PGI_URL) }));
  }, 30_000);

  it("signing the term sheet sends the PGI link", async () => {
    process.env.SIGNNOW_WEBHOOK_SECRET = "whsec-test";
    h.query.mockImplementation(answerBySql([[/metadata->'offer_signnow'->>'group_id'/, { rows: [{ id: APP }] }]]));
    const { default: signnow } = await import("../../routes/signnow.js");
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    app.use("/api", signnow);
    const raw = JSON.stringify({ event: "document.complete", document_group_id: "grp-ts" });
    const sig = crypto.createHmac("sha256", "whsec-test").update(raw).digest("base64");
    const r = await request(app).post("/api/webhooks/signnow").set("Content-Type", "application/json").set("x-signnow-signature", sig).send(raw);
    expect(r.body).toMatchObject({ received: true, match: "offer_term_sheet" });
    expect(h.pgiLinks).toEqual([APP]);
  }, 30_000);

  it("'signed' means the signed term sheet is on file or the stage change was recorded", async () => {
    h.real = true;
    const { termSheetSigned } = await import("../termSheetSigned.js");
    h.query.mockImplementation(answerBySql([[/AS signed/, { rows: [{ signed: true }] }]]));
    expect(await termSheetSigned(APP)).toBe(true);
    const sql = sqlText(callsMatching(h.query, /AS signed/)[0]![0]);
    expect(sql).toContain("document_type = 'signed_term_sheet'");
    expect(sql).toContain("trigger = 'offer_term_sheet_signed'");
    expect(callsMatching(h.query, /AS signed/)[0]![1]).toEqual([APP]);
    h.query.mockImplementation(answerBySql([[/AS signed/, { rows: [{ signed: false }] }]]));
    expect(await termSheetSigned(APP)).toBe(false);
    h.query.mockImplementation(async () => { throw new Error("db down"); });
    expect(await termSheetSigned(APP)).toBe(false);
  });
});
