// BF_SERVER_v809_SMS_UPDATES_CONSENT - the client's "Text me updates about my application" tick on the sign-in
// screen is recorded when the code is verified. An unticked box changes nothing.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

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

const UPSERT = /INSERT INTO sms_updates_consents/;

describe("v809 sign-in records the text-updates choice", () => {
  beforeEach(async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.query.mockReset().mockImplementation(answerBySql([]));
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    (await import("../lib/otpGuard.js"))._resetOtpGuard();
  });
  const app = async () => (await import("./helpers/otpVerifyApp.js")).otpApp();

  it("a ticked box is saved for that number, with the checkbox wording", async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15874441234", code: "123456", userType: "client", sms_updates_consent: true });
    expect(res.status).toBe(200);
    const saved = callsMatching(h.query, UPSERT);
    expect(saved).toHaveLength(1);
    const params = saved[0]![1] as unknown[];
    expect(params[0]).toBe("5874441234");
    expect(params[1]).toBe(true);
    expect(String(params[2])).toContain("Text me updates about my application");
    expect(params[3]).toBe("sign_in");
  });

  it("an unticked box, or anything but true, saves nothing", async () => {
    for (const v of [false, "true", 1, undefined]) {
      h.query.mockClear();
      await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15874441234", code: "123456", userType: "client", sms_updates_consent: v });
      expect(callsMatching(h.query, UPSERT)).toHaveLength(0);
    }
  });

  it("a wrong code saves nothing", async () => {
    h.verificationCheck.mockResolvedValue({ status: "denied" });
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15874441234", code: "000000", userType: "client", sms_updates_consent: true });
    expect(res.status).toBe(401);
    expect(callsMatching(h.query, UPSERT)).toHaveLength(0);
  });
});
