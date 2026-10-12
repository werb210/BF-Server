// BF_SERVER_LENDER_LOGIN_NOTIFY_v1
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
  notifyAllStaff: vi.fn(),
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
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notifyAllStaff }));

const LENDER = { id: "88888888-8888-8888-8888-888888888888", name: "Acme Capital" };

async function verify(body: Record<string, unknown>) {
  const { otpApp } = await import("../../__tests__/helpers/otpVerifyApp.js");
  return request(await otpApp()).post("/api/auth/otp/verify").send({ phone: "+14035550155", code: "123456", ...body });
}

beforeEach(() => {
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
  h.query.mockReset().mockImplementation(answerBySql([[/FROM lenders/, { rows: [LENDER] }]]));
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
  h.notifyAllStaff.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lender portal login staff notification", () => {
  it("is emitted from the successful lender OTP branch, after the token is minted", async () => {
    const res = await verify({ userType: "lender" });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    await vi.waitFor(() => expect(h.notifyAllStaff).toHaveBeenCalledTimes(1));
    expect(h.notifyAllStaff.mock.calls[0][0]).toMatchObject({ notificationType: "lender_portal_login" });
  });

  it("is not emitted for a failed lender login, a wrong code, or another login type", async () => {
    h.query.mockImplementation(answerBySql([]));
    expect((await verify({ userType: "lender" })).status).toBe(403);
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [LENDER] }]]));
    h.verificationCheck.mockResolvedValue({ status: "denied" });
    expect((await verify({ userType: "lender" })).status).toBe(401);
    h.verificationCheck.mockResolvedValue({ status: "approved" });
    expect((await verify({})).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(h.notifyAllStaff).not.toHaveBeenCalled();
  });

  it("creates a bell-only notification linked to the lender", async () => {
    await verify({ userType: "lender" });
    await vi.waitFor(() => expect(h.notifyAllStaff).toHaveBeenCalled());
    expect(h.notifyAllStaff.mock.calls[0][0]).toMatchObject({
      skipSms: true,
      refTable: "lenders",
      refId: LENDER.id,
      contextUrl: `/lenders/${LENDER.id}`,
      body: "Acme Capital signed into the lender portal.",
    });
  });

  it("is detached: a notification outage never blocks or fails the login, and is logged", async () => {
    let release: () => void = () => undefined;
    h.notifyAllStaff.mockImplementation(() => new Promise((_resolve, reject) => { release = () => reject(new Error("bell down")); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await verify({ userType: "lender" });
    // The response arrived while the notification was still pending.
    expect(res.status).toBe(200);
    release();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[otp_verify] lender login notification failed", { err: "Error: bell down" }));
  });
});
