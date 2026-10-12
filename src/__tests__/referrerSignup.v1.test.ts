// BF_SERVER_REFERRER_SIGNUP_v1 - referrer self-signup + SignNow agreement gate.
// Signup creates a pending referrer + agreement session; the webhook and the
// verified complete endpoint activate them; OTP login is blocked until active.
import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  order: [] as string[],
  apiKey: true,
  groupSigned: false,
  verify: vi.fn(),
  pdf: vi.fn(async (_input: unknown) => new Uint8Array([37, 80, 68, 70])),
  fromTemplate: vi.fn(),
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../lib/db.js", async (orig) => ({ ...(await orig<any>()), runQuery: (sql: unknown, params?: unknown[]) => h.query(sql, params) }));
vi.mock("../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<any>()),
  isApiKeyConfigured: () => h.apiKey,
  createDocumentFromTemplate: h.fromTemplate,
  uploadDocumentWithFieldExtract: async (_pdf: unknown, name: string) => { h.order.push("upload"); return { documentId: "doc-1", name }; },
  createDocumentGroup: async () => { h.order.push("group"); return { groupId: "grp-1" }; },
  createEmbeddedGroupInvite: async () => { h.order.push("invite"); return { inviteId: "inv-1" }; },
  createEmbeddedGroupLink: async () => { h.order.push("link"); return { url: "https://signnow.test/sign/grp-1" }; },
  getDocumentGroupStatus: async () => ({ signed: h.groupSigned }),
}));
vi.mock("../signnow/referrerAgreementPdfBuilder.js", () => ({ buildReferrerAgreementPdf: h.pdf }));
// The production OTP verify path, with Twilio Verify faked.
vi.mock("../config/runtime.js", async (orig) => ({ ...(await orig<any>()), isTest: false }));
vi.mock("../lib/sharedClients.js", async (orig) => ({
  ...(await orig<any>()),
  sharedTwilio: () => ({ verify: { v2: { services: () => ({ verificationChecks: { create: h.verify } }) } } }),
}));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));

import referrerRoutes from "../routes/referrerSelf.js";
import authRoutes from "../routes/auth.js";
import signnowRoutes from "../routes/signnow.js";
import { signAccessToken, verifyAccessToken } from "../auth/jwt.js";
import { ROLES } from "../auth/roles.js";
import { referrerAgreementConfigured } from "../modules/referrals/referrerAgreement.service.js";

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use("/api/referrer", referrerRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", signnowRoutes);

const SIGNUP = {
  full_name: "Riley Referrer", email: "riley@x.example", phone: "(403) 523-0100",
  street: "1 Main St", city: "Calgary", province: "AB", postal_code: "T2P 1A1", etransfer_email: "pay@x.example",
};
const signup = (body: Record<string, unknown> = {}) => request(app).post("/api/referrer/signup").send({ ...SIGNUP, ...body });
const userRow = (over: Record<string, unknown> = {}) => ({ id: "ref-1", first_name: "Riley", last_name: "Referrer", phone_number: "+14035230100", referrer_status: "pending_agreement", agreement_document_group_id: "grp-1", ...over });

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  h.order.length = 0;
  h.apiKey = true;
  h.groupSigned = false;
  h.pdf.mockClear();
  h.fromTemplate.mockClear();
  h.verify.mockReset();
  h.verify.mockResolvedValue({ status: "approved" });
  process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test";
  process.env.SIGNNOW_WEBHOOK_SECRET = "whsec-test";
  delete process.env.SIGNNOW_REFERRER_TEMPLATE_ID;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("referrer signup", () => {
  it("exposes public /signup and /signup/complete", async () => {
    const r = await signup();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ agreementConfigured: true, signingUrl: "https://signnow.test/sign/grp-1", groupId: "grp-1" });
    const c = await request(app).post("/api/referrer/signup/complete").send({});
    expect(c.status).toBe(400);
    expect(c.body.message).toBe("referrerId_required");
  });

  it("requires name/email/phone and full address", async () => {
    for (const missing of ["full_name", "email", "phone"]) {
      const r = await signup({ [missing]: "" });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("name_email_phone_required");
    }
    for (const missing of ["street", "city", "province", "postal_code"]) {
      const r = await signup({ [missing]: "" });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("address_required");
    }
    expect(callsMatching(h.query, "INSERT INTO users")).toHaveLength(0);
  });

  it("creates the referrer as a pending_agreement users row with role Referrer", async () => {
    await signup();
    const [insert] = callsMatching(h.query, "INSERT INTO users");
    expect(sqlText(insert![0])).toContain("'pending_agreement'");
    const params = insert![1] as unknown[];
    expect(params[11]).toBe(ROLES.REFERRER);
    expect(params.slice(1, 5)).toEqual(["Riley", "Referrer", "riley@x.example", "(403) 523-0100"]);
    // The agreement is recorded against the new row.
    const [record] = callsMatching(h.query, "agreement_document_group_id=$2");
    expect(record![1]).toEqual([params[0], "grp-1", "doc-1"]);
  });

  it("is idempotent: active -> login, pending -> reuse", async () => {
    h.query.mockImplementation(answerBySql([[/SELECT id::text AS id, referrer_status, agreement_document_group_id/, { rows: [{ id: "ref-1", referrer_status: "active" }] }]]));
    const active = await signup();
    expect(active.status).toBe(200);
    expect(active.body.data).toEqual({ alreadyActive: true });
    expect(callsMatching(h.query, "INSERT INTO users")).toHaveLength(0);

    h.query.mockImplementation(answerBySql([[/SELECT id::text AS id, referrer_status, agreement_document_group_id/, { rows: [{ id: "ref-1", referrer_status: "pending_agreement" }] }]]));
    const pending = await signup();
    expect(pending.body.data.referrerId).toBe("ref-1");
    expect(callsMatching(h.query, "INSERT INTO users")).toHaveLength(0);
    expect(callsMatching(h.query, /UPDATE users SET first_name=\$2/)[0]![1]).toEqual(expect.arrayContaining(["ref-1", "pay@x.example"]));
  });

  it("collects the e-transfer payout email", async () => {
    await signup();
    expect((callsMatching(h.query, "INSERT INTO users")[0]![1] as unknown[])[10]).toBe("pay@x.example");
    h.query.mockClear();
    await signup({ etransfer_email: undefined });
    expect((callsMatching(h.query, "INSERT INTO users")[0]![1] as unknown[])[10]).toBe("riley@x.example");
  });
});

describe("agreement completion is server-verified", () => {
  it("/signup/complete verifies the signature with SignNow before activating", async () => {
    h.query.mockImplementation(answerBySql([[/FROM users WHERE id::text = \$1 AND role = \$2/, { rows: [userRow()] }]]));
    const unsigned = await request(app).post("/api/referrer/signup/complete").send({ referrerId: "ref-1" });
    expect(unsigned.status).toBe(409);
    expect(unsigned.body.message).toBe("agreement_not_signed");
    expect(callsMatching(h.query, "referrer_status='active'")).toHaveLength(0);

    h.groupSigned = true;
    const signed = await request(app).post("/api/referrer/signup/complete").send({ referrerId: "ref-1" });
    expect(signed.status).toBe(200);
    expect(callsMatching(h.query, "referrer_status='active'").map((c) => c[1])).toEqual([["ref-1"]]);
  });

  it("mints a referrer token so the signer drops straight in", async () => {
    h.query.mockImplementation(answerBySql([[/FROM users WHERE id::text = \$1 AND role = \$2/, { rows: [userRow({ referrer_status: "active" })] }]]));
    const r = await request(app).post("/api/referrer/signup/complete").send({ referrerId: "ref-1" });
    expect(r.body.data.user).toEqual({ id: "ref-1", name: "Riley Referrer", userType: "referrer" });
    expect(verifyAccessToken(r.body.data.token)).toMatchObject({ sub: "referrer:ref-1", role: ROLES.REFERRER, referrerId: "ref-1" });
  });
});

describe("agreement service", () => {
  // BF_SERVER_REPAIR_STALE_TESTS_v1
  // The agreement no longer uses a shared SignNow TEMPLATE. Under
  // BF_SERVER_REFERRER_AGREEMENT_BAKE_v1 the PDF is generated per referrer with
  // their details already printed in, then uploaded directly - so the referrer
  // only supplies a signature. SIGNNOW_REFERRER_TEMPLATE_ID is dead.
  it("is env-gated on the API key alone, with no template id", async () => {
    expect(referrerAgreementConfigured()).toBe(true);
    h.apiKey = false;
    process.env.SIGNNOW_REFERRER_TEMPLATE_ID = "tpl-1";
    expect(referrerAgreementConfigured()).toBe(false);
    const r = await signup();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ agreementConfigured: false });
    expect(h.order).toEqual([]);
  });

  it("bakes the referrer's details into the PDF instead of prefilling a template", async () => {
    await signup({ company_name: "Riley Co" });
    expect(h.pdf).toHaveBeenCalledWith(expect.objectContaining({
      fullName: "Riley Referrer", company: "Riley Co", email: "riley@x.example", street: "1 Main St",
      cityProvincePostal: "Calgary AB T2P 1A1", payoutEmail: "pay@x.example",
    }));
    expect(h.fromTemplate).not.toHaveBeenCalled();
  });

  it("uploads -> group -> embedded invite -> link", async () => {
    await signup();
    expect(h.order).toEqual(["upload", "group", "invite", "link"]);
  });
});

describe("webhook + login gating", () => {
  const signedPost = (body: unknown) => {
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", "whsec-test").update(raw).digest("base64");
    return request(app).post("/api/webhooks/signnow").set("Content-Type", "application/json").set("x-signnow-signature", sig).send(raw);
  };

  it("the SignNow webhook activates a referrer when their agreement group signs", async () => {
    h.query.mockImplementation(answerBySql([[/from users\s+where role = 'Referrer'/, { rows: [{ id: "ref-1" }] }]]));
    const r = await signedPost({ event: "document.complete", document_group_id: "grp-1" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true, match: "referrer" });
    const [lookup] = callsMatching(h.query, /agreement_document_group_id = any/);
    expect(lookup![1]).toEqual([["grp-1"]]);
    expect(callsMatching(h.query, "referrer_status='active'").map((c) => c[1])).toEqual([["ref-1"]]);
  });

  it("OTP login refuses referrers whose agreement is not yet signed", async () => {
    const login = () => request(app).post("/api/auth/otp/verify").set("X-Forwarded-For", "203.0.113.20").send({ phone: "+14035230100", code: "123456", userType: "referrer" });
    h.query.mockImplementation(answerBySql([[/FROM users/, { rows: [{ id: "ref-1", first_name: "Riley", last_name: null, profile_complete: true, referrer_status: "pending_agreement" }] }]]));
    const pending = await login();
    expect(pending.status).toBe(403);
    expect(pending.body).toEqual({ error: "referrer_agreement_pending" });

    h.query.mockImplementation(answerBySql([[/FROM users/, { rows: [{ id: "ref-1", first_name: "Riley", last_name: null, profile_complete: true, referrer_status: "active" }] }]]));
    const active = await login();
    expect(active.status).toBe(200);
    expect(verifyAccessToken(active.body.data.token).referrerId).toBe("ref-1");
  });
});

describe("token type", () => {
  it("AccessTokenPayload carries referrerId", () => {
    const token = signAccessToken({ sub: "referrer:r1", role: ROLES.REFERRER, tokenVersion: 0, referrerId: "r1" });
    expect(verifyAccessToken(token).referrerId).toBe("r1");
  });
});
