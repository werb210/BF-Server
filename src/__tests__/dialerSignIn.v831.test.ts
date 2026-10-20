// BF_SERVER_v831_DIALER_POLISH - the dialler's sign-in: a number that is not staff is told so, and a working staff
// token can be renewed before its 7 days run out.
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { bearer, STAFF_USER_ID } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  findAuthUserById: vi.fn(),
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
  findAuthUserById: h.findAuthUserById,
}));

const staffUser = (over: Record<string, unknown> = {}) => ({
  id: STAFF_USER_ID, role: "Staff", active: true, disabled: false, tokenVersion: 0, phoneNumber: "+15875550100", silo: "BF", ...over,
});

describe("v831 dialler sign-in", () => {
  beforeEach(async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.query.mockReset().mockImplementation(answerBySql([]));
    h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
    h.findAuthUserById.mockReset().mockResolvedValue(staffUser());
    h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    (await import("../lib/otpGuard.js"))._resetOtpGuard();
  });
  const app = async () => (await import("./helpers/otpVerifyApp.js")).otpApp();

  it("a number that isn't staff is told so instead of getting a client sign-in", async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15874441234", code: "123456", userType: "staff" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_staff");
    expect(res.body.message).toContain("isn't set up as a Boreal staff account");
  });

  it("a staff number signs in as before", async () => {
    h.findAuthUserByPhone.mockResolvedValue(staffUser());
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15875550100", code: "123456", userType: "staff" });
    expect(res.status).toBe(200);
    expect((jwt.decode(res.body.data.token) as any).role).toBe("Staff");
  });

  it("renews a working staff token for another 7 days", async () => {
    const res = await request(await app()).post("/api/auth/session/renew").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.data.token) as any;
    expect(claims.sub).toBe(STAFF_USER_ID);
    expect(claims.exp - claims.iat).toBe(7 * 24 * 3600);
  });

  it("won't renew for a user who is no longer active staff", async () => {
    h.findAuthUserById.mockResolvedValue(staffUser({ active: false }));
    expect((await request(await app()).post("/api/auth/session/renew").set("Authorization", bearer("Staff"))).status).toBe(401);
    h.findAuthUserById.mockResolvedValue(staffUser({ role: "Referrer" }));
    expect((await request(await app()).post("/api/auth/session/renew").set("Authorization", bearer("Staff"))).status).toBe(401);
    expect((await request(await app()).post("/api/auth/session/renew")).status).toBe(401);
  });
});
