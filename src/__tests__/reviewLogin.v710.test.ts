// BF_SERVER_REVIEW_LOGIN_v710
import request from "supertest";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { isReviewPhone, reviewCodeMatches } from "../services/reviewLogin.js";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
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

describe("store-review sign-in", () => {
  afterEach(() => {
    delete process.env.REVIEW_LOGIN_PHONE;
    delete process.env.REVIEW_LOGIN_CODE;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("is off unless both settings are present", () => {
    expect(isReviewPhone("+18255550199")).toBe(false);
    process.env.REVIEW_LOGIN_PHONE = "+18255550199";
    expect(isReviewPhone("+18255550199")).toBe(false);
  });
  it("matches the configured number and only its code", () => {
    process.env.REVIEW_LOGIN_PHONE = "+18255550199";
    process.env.REVIEW_LOGIN_CODE = "864213";
    expect(isReviewPhone("(825) 555-0199")).toBe(true);
    expect(isReviewPhone("+14035550101")).toBe(false);
    expect(reviewCodeMatches("+18255550199", "864213")).toBe(true);
    expect(reviewCodeMatches("+18255550199", "000000")).toBe(false);
    expect(reviewCodeMatches("+14035550101", "864213")).toBe(false);
  });

  describe("the sign-in skips the text and skips Twilio's check only for that number", () => {
    beforeEach(async () => {
      process.env.REVIEW_LOGIN_PHONE = "+18255550199";
      process.env.REVIEW_LOGIN_CODE = "864213";
      vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
      h.query.mockReset().mockImplementation(answerBySql([]));
      h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
      h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
      h.verificationCreate.mockReset().mockResolvedValue({ status: "pending" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      (await import("../lib/otpGuard.js"))._resetOtpGuard();
    });
    const app = async () => (await import("./helpers/otpVerifyApp.js")).otpApp();

    it("start sends no text for the review number", async () => {
      const res = await request(await app()).post("/api/auth/otp/start").send({ phone: "+18255550199" });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ sent: true });
      expect(h.verificationCreate).not.toHaveBeenCalled();
    });

    it("start still texts every other number", async () => {
      const res = await request(await app()).post("/api/auth/otp/start").send({ phone: "+14035550101" });
      expect(res.status).toBe(200);
      expect(h.verificationCreate).toHaveBeenCalledWith({ to: "+14035550101", channel: "sms" });
    });

    it("verify accepts only the configured code for the review number, without asking Twilio", async () => {
      const ok = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+18255550199", code: "864213" });
      expect(ok.status).toBe(200);
      expect(typeof ok.body.data.token).toBe("string");
      const bad = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+18255550199", code: "000000" });
      expect(bad.status).toBe(401);
      expect(h.verificationCheck).not.toHaveBeenCalled();
    });

    it("verify asks Twilio for every other number", async () => {
      const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+14035550101", code: "864213" });
      expect(res.status).toBe(200);
      expect(h.verificationCheck).toHaveBeenCalledWith({ to: "+14035550101", code: "864213" });
    });
  });
});
