// BF_SERVER_REFERRER_SELF_v1 / BF_SERVER_REFERRER_OTP_v1 - referrer portal
// backend: OTP login mints a referrer-bound token, and the self-service routes
// are gated to the Referrer role and scoped to the token's referrerId.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
  submitReferral: vi.fn(),
}));
vi.mock("../config/runtime.js", () => ({ isTest: false }));
vi.mock("../middleware/authRateLimit.js", async () => (await import("./helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("./helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: h.query }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));
vi.mock("../modules/referrals/referrals.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/referrals/referrals.service.js")),
  submitReferral: h.submitReferral,
}));

const REFERRER_ID = "55555555-5555-5555-5555-555555555555";
const PHONE = "+14035550122";

const referrerToken = (claims: Record<string, unknown> = {}) =>
  jwt.sign({ sub: `referrer:${REFERRER_ID}`, role: "Referrer", referrerId: REFERRER_ID, tokenVersion: 0, ...claims }, String(process.env.JWT_SECRET), { algorithm: "HS256" });

async function referrerApp() {
  const router = (await import("../routes/referrerSelf.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/referrer", router);
  return app;
}

async function verifyReferrer() {
  const { otpApp } = await import("./helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", userType: "referrer" });
}

beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  h.submitReferral.mockReset().mockResolvedValue({ contactId: "ct-1", companyId: "co-1", refCode: "REF1" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("referrer route mount", () => {
  it("is registered under /referrer (=> /api/referrer/*)", async () => {
    const { API_ROUTE_MOUNTS } = await import("../routes/routeRegistry.js");
    const referrerSelfRoutes = (await import("../routes/referrerSelf.js")).default;
    const mount = API_ROUTE_MOUNTS.find((m) => m.router === referrerSelfRoutes);
    expect(mount?.path).toBe("/referrer");
  }, 60_000); // the registry imports every router
});

describe("referrer self-service routes", () => {
  it("exposes pipeline, add-referral, profile and me", async () => {
    const app = await referrerApp();
    const auth = { Authorization: `Bearer ${referrerToken()}` };
    h.query.mockImplementation(answerBySql([[/FROM users\s+WHERE id::text = \$1/, { rows: [{ id: REFERRER_ID, first_name: "Rae" }] }]]));
    expect((await request(app).get("/api/referrer/pipeline").set(auth)).status).toBe(200);
    expect((await request(app).post("/api/referrer/add-referral").set(auth).send({ full_name: "Bo Client", phone: "4035550133" })).status).toBe(201);
    expect((await request(app).post("/api/referrer/profile").set(auth).send({ city: "Calgary" })).status).toBe(200);
    expect((await request(app).get("/api/referrer/me").set(auth)).status).toBe(200);
  });

  it("gates every route to the Referrer role", async () => {
    const app = await referrerApp();
    const staff = { Authorization: `Bearer ${referrerToken({ role: "Staff" })}` };
    for (const [method, path] of [["get", "/pipeline"], ["post", "/add-referral"], ["post", "/profile"], ["get", "/me"]] as const) {
      const res = await (request(app) as any)[method](`/api/referrer${path}`).set(staff).send({});
      expect(res.status, path).toBe(403);
      expect(res.body.message).toBe("referrer_role_required");
    }
    expect(h.query).not.toHaveBeenCalled();
    expect(h.submitReferral).not.toHaveBeenCalled();
  });

  it("pipeline is scoped to the token's referrerId, BF-silo-scoped, and joins application stage", async () => {
    h.query.mockImplementation(answerBySql([[/FROM contacts c/, { rows: [{ id: "ct-1", application_stage: "Received" }] }]]));
    const res = await request(await referrerApp()).get("/api/referrer/pipeline").set("Authorization", `Bearer ${referrerToken()}`);
    expect(res.body.referrals).toEqual([{ id: "ct-1", application_stage: "Received" }]);
    const [call] = callsMatching(h.query, /FROM contacts c/);
    const sql = String(call[0]);
    expect(sql).toContain("c.referrer_id::text = $1");
    expect(sql).toContain("c.silo = 'BF'");
    expect(sql).toContain("a.pipeline_state AS application_stage");
    expect(call[1]).toEqual([REFERRER_ID]);
  });

  it("add-referral reuses the canonical submitReferral service, tagged to the referrer", async () => {
    const app = await referrerApp();
    const auth = { Authorization: `Bearer ${referrerToken()}` };
    const bad = await request(app).post("/api/referrer/add-referral").set(auth).send({ full_name: "No Phone" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("name_and_phone_required");

    const ok = await request(app).post("/api/referrer/add-referral").set(auth).send({ full_name: "Bo Client", phone: "4035550133", referrer_name: "Rae" });
    expect(ok.status).toBe(201);
    expect(h.submitReferral).toHaveBeenCalledTimes(1);
    expect(h.submitReferral.mock.calls[0][0]).toMatchObject({ contactName: "Bo Client", phone: "4035550133", referrerId: REFERRER_ID });
  });
});

describe("referrer OTP login", () => {
  it("mints a referrer-bound token for a Referrer user matched by phone", async () => {
    h.query.mockImplementation(answerBySql([[/FROM users/, { rows: [{ id: REFERRER_ID, first_name: "Rae", last_name: "Ferr", profile_complete: true, referrer_status: "active" }] }]]));
    const res = await verifyReferrer();
    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.data.token) as Record<string, unknown>;
    expect(claims.role).toBe("Referrer");
    expect(claims.referrerId).toBe(REFERRER_ID);
    expect(res.body.data.user).toEqual({ id: REFERRER_ID, name: "Rae Ferr", phone: PHONE, userType: "referrer" });
    const [lookup] = callsMatching(h.query, /FROM users/);
    expect(lookup[1]).toEqual([PHONE, "Referrer"]);
    // The staff path is not consulted for a referrer-portal login.
    expect(h.findAuthUserByPhone).not.toHaveBeenCalled();
  });

  it("refuses no-match and ambiguous shared phones", async () => {
    expect((await verifyReferrer()).body.error).toBe("no_referrer_for_phone");
    h.query.mockImplementation(answerBySql([[/FROM users/, { rows: [{ id: "r1" }, { id: "r2" }] }]]));
    const res = await verifyReferrer();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ambiguous_referrer_phone");
  });
});
