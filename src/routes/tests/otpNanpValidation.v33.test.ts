// BF_SERVER_OTP_NANP_VALIDATION_v33
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { isValidNanp } from "../auth.js";

const h = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
}));
vi.mock("../../config/runtime.js", () => ({ isTest: false }));
vi.mock("../../middleware/authRateLimit.js", async () => (await import("../../__tests__/helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("../../__tests__/helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../../lib/db.js", async () => ({ ...(await vi.importActual<any>("../../lib/db.js")), runQuery: h.query }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));

describe("isValidNanp", () => {
  it("accepts real numbers seen in today's logs", () => {
    expect(isValidNanp("+14165096632")).toBe(true);
    expect(isValidNanp("+16474500660")).toBe(true);
    expect(isValidNanp("+12892317555")).toBe(true);
    expect(isValidNanp("+18254511768")).toBe(true);
  });

  it("rejects an NPA or NXX starting with 0 or 1", () => {
    expect(isValidNanp("+11234567890")).toBe(false);
    expect(isValidNanp("+14161234567")).toBe(false);
  });

  it("rejects N11 service codes in either position", () => {
    expect(isValidNanp("+19115551234")).toBe(false);
    expect(isValidNanp("+14169115555")).toBe(false);
  });

  it("leaves non-NANP numbers for Twilio to judge", () => {
    expect(isValidNanp("+3068312165")).toBe(true);
    expect(isValidNanp("+447700900000")).toBe(true);
  });
});

describe("otp error mapping", () => {
  beforeEach(async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    h.verificationCreate.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    (await import("../../lib/otpGuard.js"))._resetOtpGuard();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  async function startWith(providerError: string) {
    h.verificationCreate.mockRejectedValue(new Error(providerError));
    const { otpApp } = await import("../../__tests__/helpers/otpVerifyApp.js");
    return request(await otpApp()).post("/api/auth/otp/start").send({ phone: "+14035550166" });
  }

  it("returns 400 for a destination Twilio refuses, not 500", async () => {
    for (const msg of ["Invalid parameter `To`: +14035550166", "Invalid parameter To", "The number is not a valid phone number"]) {
      const res = await startWith(msg);
      expect(res.status, msg).toBe(400);
      expect(res.body.error).toBe("invalid_phone");
    }
  });

  it("keeps the 429 rate-limit mapping ahead of it", async () => {
    // A message matching both patterns is a rate limit, not a bad number.
    const res = await startWith("Max send attempts reached; invalid parameter To");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("otp_rate_limited");
    expect(res.headers["retry-after"]).toBe("600");
  });

  it("still has a 500 for genuine server failures", async () => {
    const res = await startWith("socket hang up");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("OTP failed");
  });

  it("refuses a structurally impossible NANP number before any Twilio call", async () => {
    const { otpApp } = await import("../../__tests__/helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/start").send({ phone: "+19115551234" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Phone is not a valid number");
    expect(h.verificationCreate).not.toHaveBeenCalled();
  });
});

// BF_SERVER_OTP_TEST_FIXTURES_VALID_NANP_v34
describe("fictional test numbers", () => {
  it("accepts the NANPA-reserved 555-01xx range used by the OTP tests", () => {
    expect(isValidNanp("+15555550123")).toBe(true);
    expect(isValidNanp("+15555550188")).toBe(true);
    expect(isValidNanp("+15555550199")).toBe(true);
  });

  it("still rejects the 555-000-xxxx shape those fixtures used to carry", () => {
    expect(isValidNanp("+15550001234")).toBe(false);
  });
});
