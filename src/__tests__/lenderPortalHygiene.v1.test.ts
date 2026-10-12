// BF_SERVER_LENDER_OTP_AMBIGUOUS_v1 and lender-portal hygiene fixes.
//  1. lender uploads read and write lender_documents scoped to the token's lender
//  2. stale /api/lender/applications manifest lines removed
//  3. OTP login refuses a phone that matches more than one active lender
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
  notifyAllStaff: vi.fn(),
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
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notifyAllStaff }));
vi.mock("../ai/embeddingService.js", () => ({ extractTextFromBuffer: async () => "" }));

const LENDER_ID = "44444444-4444-4444-4444-444444444444";
const PHONE = "+14035550111";

function lenderToken(lenderId = LENDER_ID) {
  return jwt.sign({ sub: `lender:${lenderId}`, role: "Lender", lenderId, tokenVersion: 0 }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
}

async function lenderApp() {
  const router = (await import("../routes/lenderSelf.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/lender", router);
  return app;
}

async function verifyLender() {
  const { otpApp } = await import("./helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", userType: "lender" });
}

beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  h.notifyAllStaff.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lender uploads", () => {
  it("lists only the token's lender's documents", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lender_documents/, { rows: [{ id: "d1", filename: "sheet.pdf" }] }]]));
    const res = await request(await lenderApp()).get("/api/lender/uploads").set("Authorization", `Bearer ${lenderToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: "d1", filename: "sheet.pdf" }]);
    const [call] = callsMatching(h.query, /FROM lender_documents/);
    expect(String(call[0])).toContain("lender_id::text = $1");
    expect(call[1]).toEqual([LENDER_ID]);
  });

  it("stores an upload as a lender_documents row for the token's lender", async () => {
    h.query.mockImplementation(answerBySql([[/INSERT INTO lender_documents/, { rows: [{ id: "d2", filename: "rates.txt" }] }]]));
    const res = await request(await lenderApp()).post("/api/lender/uploads")
      .set("Authorization", `Bearer ${lenderToken()}`)
      .attach("file", Buffer.from("rate sheet"), { filename: "rates.txt", contentType: "text/plain" });
    expect(res.status).toBe(201);
    const [insert] = callsMatching(h.query, /INSERT INTO lender_documents/);
    expect((insert[1] as unknown[])[0]).toBe(LENDER_ID);
    expect((insert[1] as unknown[])[1]).toBe("rates.txt");
  });

  it("refuses a token without the lender role", async () => {
    const staff = jwt.sign({ sub: "s1", role: "Staff", lenderId: LENDER_ID }, String(process.env.JWT_SECRET));
    const res = await request(await lenderApp()).get("/api/lender/uploads").set("Authorization", `Bearer ${staff}`);
    expect(res.status).toBe(403);
    expect(callsMatching(h.query, /FROM lender_documents/)).toHaveLength(0);
  });
});

describe("route registry hygiene", () => {
  it("stale lender applications manifest lines are gone", async () => {
    const { ROUTES } = await import("../routes/routeRegistry.js");
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/api/lender/me");
    expect(paths).not.toContain("/api/lender/applications");
    expect(paths).not.toContain("/api/lender/applications/:id");
  }, 60_000); // the registry imports every router
});

describe("lender OTP shared-phone guard", () => {
  it("refuses ambiguous multi-lender matches instead of picking one (no LIMIT 1)", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ id: "l1", name: "A" }, { id: "l2", name: "B" }] }]]));
    const res = await verifyLender();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ambiguous_lender_phone");
    expect(res.body.data).toBeUndefined();
    const [lookup] = callsMatching(h.query, /FROM lenders/);
    expect(String(lookup[0])).not.toContain("LIMIT 1");
    expect(h.notifyAllStaff).not.toHaveBeenCalled();
  });

  it("rejects no-match", async () => {
    const res = await verifyLender();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_lender_for_phone");
  });

  it("mints a lender token on a single match", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ id: LENDER_ID, name: "Acme Capital" }] }]]));
    const res = await verifyLender();
    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.data.token) as Record<string, unknown>;
    expect(claims.role).toBe("Lender");
    expect(claims.lenderId).toBe(LENDER_ID);
    expect(res.body.data.user).toMatchObject({ id: LENDER_ID, userType: "lender" });
  });
});
