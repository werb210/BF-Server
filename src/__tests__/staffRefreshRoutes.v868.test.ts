// BF_SERVER_v868_SLIDING_REFRESH - a staff sign-in returns a refresh token; POST /api/auth/refresh trades it for
// a new access token and a new refresh token; sign-out ends it; someone who is no longer staff cannot refresh.
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRefreshTable } from "./helpers/fakeRefreshTable.js";
import { STAFF_USER_ID } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({
  table: null as null | { query: (sql: unknown, params?: unknown[]) => Promise<any>; rows: any[] },
  findAuthUserByPhone: vi.fn(),
  findAuthUserById: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
}));
const query = (sql: unknown, params?: unknown[]) => h.table!.query(sql, params);
vi.mock("../config/runtime.js", () => ({ isTest: false }));
vi.mock("../middleware/authRateLimit.js", async () => (await import("./helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("./helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: query }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query }, dbQuery: query }));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
  findAuthUserById: h.findAuthUserById,
}));

const staffUser = (over: Record<string, unknown> = {}) => ({
  id: STAFF_USER_ID, role: "Staff", active: true, disabled: false, tokenVersion: 0, phoneNumber: "+15875550100", silo: "BF", ...over,
});

describe("staff sliding refresh routes", () => {
  beforeEach(async () => {
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.table = fakeRefreshTable();
    h.findAuthUserByPhone.mockReset().mockResolvedValue(staffUser());
    h.findAuthUserById.mockReset().mockResolvedValue(staffUser());
    h.verificationCheck.mockReset().mockResolvedValue({ status: "approved" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (await import("../lib/otpGuard.js"))._resetOtpGuard();
  });
  const app = async () => (await import("./helpers/otpVerifyApp.js")).otpApp();
  const signIn = async () => {
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15875550100", code: "123456" });
    expect(res.status).toBe(200);
    return res.body.data as { token: string; refreshToken: string; refreshExpiresAt: string; sessionExpiresAt: string };
  };

  it("a staff text-code sign-in returns a refresh token alongside the access token", async () => {
    const data = await signIn();
    expect((jwt.decode(data.token) as any).sub).toBe(STAFF_USER_ID);
    expect(data.refreshToken).toMatch(/^srt_/);
    expect(new Date(data.sessionExpiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });

  it("a client sign-in gets no refresh token", async () => {
    h.findAuthUserByPhone.mockResolvedValue(null);
    const res = await request(await app()).post("/api/auth/otp/verify").send({ phone: "+15874441234", code: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
  });

  it("refresh returns a new access token and rotates the refresh token", async () => {
    const data = await signIn();
    const res = await request(await app()).post("/api/auth/refresh").send({ refreshToken: data.refreshToken });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const claims = jwt.decode(res.body.data.token) as any;
    expect(claims.sub).toBe(STAFF_USER_ID);
    expect(claims.role).toBe("Staff");
    expect(claims.exp - claims.iat).toBe(7 * 24 * 3600);
    expect(res.body.data.refreshToken).not.toBe(data.refreshToken);
    const again = await request(await app()).post("/api/auth/refresh").send({ refreshToken: data.refreshToken });
    expect(again.status).toBe(409);
  });

  it("someone who is no longer active staff cannot refresh, and the chain ends", async () => {
    const data = await signIn();
    h.findAuthUserById.mockResolvedValue(staffUser({ active: false }));
    expect((await request(await app()).post("/api/auth/refresh").send({ refreshToken: data.refreshToken })).status).toBe(401);
    expect(h.table!.rows.every((r) => r.revoked_at)).toBe(true);
  });

  it("a role change or sign-out-everywhere (token version bumped) ends the chain", async () => {
    const data = await signIn();
    h.findAuthUserById.mockResolvedValue(staffUser({ tokenVersion: 1 }));
    const res = await request(await app()).post("/api/auth/refresh").send({ refreshToken: data.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("signed_out_everywhere");
  });

  it("garbage and missing tokens get 401", async () => {
    expect((await request(await app()).post("/api/auth/refresh").send({})).status).toBe(401);
    expect((await request(await app()).post("/api/auth/refresh").send({ refreshToken: "srt_" + "x".repeat(43) })).status).toBe(401);
  });

  it("sign-out with the refresh token ends the chain", async () => {
    const data = await signIn();
    expect((await request(await app()).post("/api/auth/logout").send({ refreshToken: data.refreshToken })).status).toBe(204);
    expect((await request(await app()).post("/api/auth/refresh").send({ refreshToken: data.refreshToken })).status).toBe(401);
    expect((await request(await app()).post("/api/auth/logout").send({})).status).toBe(204);
    const other = await signIn();
    expect((await request(await app()).post("/api/auth/refresh/revoke").send({ refreshToken: other.refreshToken })).status).toBe(204);
    expect((await request(await app()).post("/api/auth/refresh").send({ refreshToken: other.refreshToken })).status).toBe(401);
  });
});
