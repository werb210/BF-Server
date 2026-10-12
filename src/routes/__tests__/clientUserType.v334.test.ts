// BF_SERVER_CLIENT_USERTYPE_v334
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
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

const PHONE = "+14035550144";
const STAFF = { id: "77777777-7777-7777-7777-777777777777", role: "Staff", active: true, disabled: false, tokenVersion: 0, phoneNumber: PHONE };

async function verify(body: Record<string, unknown> = {}) {
  const { otpApp } = await import("../../__tests__/helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: PHONE, code: "123456", ...body });
}
const claimsOf = (res: request.Response) => jwt.decode(res.body.data.token) as Record<string, any>;

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(STAFF);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the client app gets a client token, whoever the phone belongs to", () => {
  it("reads userType from the verify body: a staff phone asking for client gets a client token", async () => {
    const res = await verify({ userType: "client" });
    expect(res.status).toBe(200);
    expect(claimsOf(res).role).toBe("client");
    expect(claimsOf(res).sub).toBe(`client:${PHONE}`);
  });

  it("still mints a staff token for the portal, which sends no userType", async () => {
    const res = await verify();
    expect(res.status).toBe(200);
    const claims = claimsOf(res);
    expect(claims.role).toBe("Staff");
    expect(claims.sub).toBe(STAFF.id);
    expect(Array.isArray(claims.capabilities)).toBe(true);
    expect(claims.capabilities.length).toBeGreaterThan(0);
  });

  it("the client token still carries role client, which no staff check accepts", async () => {
    h.findAuthUserByPhone.mockResolvedValue(null);
    const res = await verify();
    const claims = claimsOf(res);
    expect(claims.role).toBe("client");
    expect(claims.isClient).toBe(true);
    const { ROLES } = await import("../../auth/roles.js");
    expect(Object.values(ROLES)).not.toContain("client");
  });

  it("says which reason produced a client token", async () => {
    await verify({ userType: "client" });
    expect(logSpy).toHaveBeenCalledWith("[otp_verify] client_fallthrough", { phone: "***0144", requestedClient: true, isActiveStaff: true });
    logSpy.mockClear();
    h.findAuthUserByPhone.mockResolvedValue(null);
    await verify();
    expect(logSpy).toHaveBeenCalledWith("[otp_verify] client_fallthrough", { phone: "***0144", requestedClient: false, isActiveStaff: false });
  });

  it("does not weaken the lender, referrer or accountant branches, which run first", async () => {
    // A staff phone that asks for a portal login is answered by that portal's branch only.
    for (const [userType, table, error] of [
      ["lender", /FROM lenders/, "no_lender_for_phone"],
      ["referrer", /FROM users/, "no_referrer_for_phone"],
      ["accountant", /FROM contacts/, "no_accountant_for_phone"],
    ] as const) {
      h.query.mockClear();
      h.findAuthUserByPhone.mockClear();
      const res = await verify({ userType });
      expect(res.status, userType).toBe(403);
      expect(res.body.error).toBe(error);
      expect(callsMatching(h.query, table)).toHaveLength(1);
      expect(h.findAuthUserByPhone).not.toHaveBeenCalled();
    }
  });
});
