// BF_SERVER_FEE_DIAGNOSE_v745
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const SECRET_DETAIL = "signnow 500 at https://internal.example/api key=abc123";
const rows = vi.hoisted(() => ({ app: null as any, texts: [] as any[] }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, params: unknown[] = []) => {
    // The client router's ownership checks (signed-in owner of APP).
    if (sql.includes("WITH app_phones AS")) return { rows: [{ total: 1, mine: params[1] === OWNER.slice(-10) ? 1 : 0, known: 1 }] };
    if (/FROM applications WHERE lower\(id::text\) = ANY/.test(sql)) return { rows: [{ id: APP }] };
    if (sql.includes("FROM applications")) return { rows: rows.app ? [rows.app] : [] };
    if (sql.includes("FROM sms_deliveries")) return { rows: rows.texts };
    return { rows: [] };
  };
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../signnow/signnowClient.js", async (orig) => ({ ...(await orig<any>()), isApiKeyConfigured: () => true }));
vi.mock("../services/feeAgreement/mediaFeeAgreement.js", async (orig) => ({
  ...(await orig<any>()),
  createFeeAgreementSigningSession: async () => { throw new Error(SECRET_DETAIL); },
}));
import { diagnoseFeeAgreement } from "../routes/portalFeeAgreement.js";
import clientRouter from "../routes/client/index.js";

beforeEach(() => {
  process.env.TWILIO_PHONE = "+15875550199"; process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.TWILIO_AUTH_TOKEN = "t";
  process.env.SENDGRID_API_KEY = "k"; process.env.SENDGRID_FROM = "a@b.ca"; delete process.env.TEST_MODE;
  rows.texts = [];
});

describe("fee agreement diagnosis", () => {
  it("names a carrier rejection with its Twilio error code", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", phone: "403-555-0100", email: "d@x.ca" } } };
    rows.texts = [{ to_number: "+14035550100", status: "undelivered", error_code: "30032", created_at: "2026-10-04T20:00:00Z" }];
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d.ok).toBe(false);
    expect(d.problems.join(" ")).toContain("text to mobile ending 0100 was undelivered (Twilio error 30032)");
    expect(d.sendingNumberLast4).toBe("0199");
  });
  it("reports a missing mobile, a missing sending number and TEST_MODE", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", email: "d@x.ca" } } };
    delete process.env.TWILIO_PHONE; process.env.TEST_MODE = "true";
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d.problems).toEqual(expect.arrayContaining([
      "no usable mobile number for the signer on this application",
      "no Twilio sending number set on the server (TWILIO_PHONE)",
      "server is in TEST_MODE - texts are skipped",
    ]));
  });
  it("is clean when everything is set", async () => {
    rows.app = { metadata: { applicant: { firstName: "Dana", phone: "4035550100", email: "d@x.ca" } } };
    rows.texts = [{ to_number: "+14035550100", status: "delivered", error_code: null, created_at: "x" }];
    const d: any = await diagnoseFeeAgreement("a1");
    expect(d).toMatchObject({ ok: true, problems: [] });
  });
  // BF_SERVER_v789_GENERIC_ERRORS - the failure detail is logged, never returned to the client.
  it("the client signing window receives a generic failure code, the detail is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).get(`/api/client/fee-agreement/session?applicationId=${APP}`).set("Authorization", token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "error", reason: "session_failed" });
    expect(JSON.stringify(r.body)).not.toContain("internal.example");
    const logged = warn.mock.calls.find((c) => c[0] === "[fee-agreement] session failed");
    expect(logged?.[1]).toEqual({ applicationId: APP, message: SECRET_DETAIL });
    warn.mockRestore();
  });
});
