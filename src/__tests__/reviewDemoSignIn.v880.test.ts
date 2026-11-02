// BF_SERVER_v880_REVIEW_DEMO - the OTP verify path seeds the reviewer's sample data for the review number only,
// and a seeding failure never blocks the sign-in.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
  ensureReviewDemoData: vi.fn(),
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
vi.mock("../services/reviewDemoData.js", () => ({ ensureReviewDemoData: h.ensureReviewDemoData }));

const REVIEW = "+18255550177";
const app = async () => (await import("./helpers/otpVerifyApp.js")).otpApp();

describe("v880 review sign-in seeds sample data", () => {
  beforeEach(async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW;
    process.env.REVIEW_LOGIN_CODE = "864213";
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.query.mockReset().mockImplementation(answerBySql([
      [/FROM applications a[\s\S]*submitted_at IS NOT NULL/, { rows: [{ id: "app-equipment" }] }],
    ]));
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
    h.verificationCreate.mockReset().mockResolvedValue({ status: "pending" });
    h.ensureReviewDemoData.mockReset().mockResolvedValue({ seeded: true, contactId: "c", applications: {}, created: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    (await import("../lib/otpGuard.js"))._resetOtpGuard();
  });
  afterEach(() => {
    delete process.env.REVIEW_LOGIN_PHONE;
    delete process.env.REVIEW_LOGIN_CODE;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("seeds for the review number once its code is accepted, before answering", async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: REVIEW, code: "864213", userType: "client" });
    expect(res.status).toBe(200);
    expect(h.ensureReviewDemoData).toHaveBeenCalledTimes(1);
    expect(h.ensureReviewDemoData).toHaveBeenCalledWith(REVIEW);
    expect(res.body.data).toMatchObject({ hasSubmittedApplication: true, submittedApplicationId: "app-equipment" });
  });

  it("does not seed when the review number's code is wrong", async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: REVIEW, code: "000000", userType: "client" });
    expect(res.status).toBe(401);
    expect(h.ensureReviewDemoData).not.toHaveBeenCalled();
  });

  it("never seeds for any other number", async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+14035550101", code: "123456", userType: "client" });
    expect(res.status).toBe(200);
    expect(h.ensureReviewDemoData).not.toHaveBeenCalled();
  });

  it("a seeding failure is logged and the sign-in still succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.ensureReviewDemoData.mockRejectedValue(new Error("db down"));
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: REVIEW, code: "864213", userType: "client" });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(warn).toHaveBeenCalledWith("[store-review] demo data failed", "db down");
  });
});
