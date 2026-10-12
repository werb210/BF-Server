// BF_SERVER_OTP_ABUSE_GUARD_v772
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), checkTextable: vi.fn(), verifyCreate: vi.fn(), twilioFactory: vi.fn() }));
// The OTP start route short-circuits in test mode; run it as it runs in production.
vi.mock("../config/runtime.js", async (orig) => ({ ...(await orig<typeof import("../config/runtime.js")>()), isTest: false }));
vi.mock("../middleware/authRateLimit.js", async (orig) => ({
  ...(await orig<typeof import("../middleware/authRateLimit.js")>()),
  otpStartLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  otpVerifyLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../db.js", async (orig) => ({ ...(await orig<typeof import("../db.js")>()), pool: { query: h.queryMock } }));
vi.mock("../lib/db.js", async (orig) => ({ ...(await orig<typeof import("../lib/db.js")>()), runQuery: h.queryMock }));
vi.mock("../lib/phoneLineType.js", async (orig) => ({ ...(await orig<typeof import("../lib/phoneLineType.js")>()), checkTextable: h.checkTextable }));
vi.mock("../lib/sharedClients.js", async (orig) => ({
  ...(await orig<typeof import("../lib/sharedClients.js")>()),
  sharedTwilio: () => ({ verify: { v2: { services: () => ({ verifications: { create: h.verifyCreate }, verificationChecks: { create: vi.fn() } }) } } }),
}));
vi.mock("twilio", () => ({ default: h.twilioFactory }));

import { isAllowedOtpDestination, checkOtpSend, _resetOtpGuard, OTP_GUARD_MESSAGES, OTP_GUARD_STATUS } from "../lib/otpGuard.js";
import { clientIpForRateLimit } from "../middleware/authRateLimit.js";
import authRouter from "../routes/auth.js";
import intRouter from "../routes/_int.js";

describe("sign-in codes only go to Canadian and US numbers", () => {
  it("allows Canada and the US", () => {
    expect(isAllowedOtpDestination("+14035550100")).toBe(true);
    expect(isAllowedOtpDestination("+15875550100")).toBe(true);
    expect(isAllowedOtpDestination("+12125550100")).toBe(true);
  });
  it("refuses the countries from the Oct 7 attack and every non-+1 number", () => {
    expect(isAllowedOtpDestination("+50937001234")).toBe(false);
    expect(isAllowedOtpDestination("+50255501234")).toBe(false);
    expect(isAllowedOtpDestination("+447700900123")).toBe(false);
    expect(isAllowedOtpDestination("")).toBe(false);
  });
  it("refuses +1 numbers that belong to Caribbean and Pacific countries", () => {
    for (const npa of ["876", "809", "829", "849", "868", "242", "246", "441", "787", "671", "900"]) {
      expect(isAllowedOtpDestination("+1" + npa + "5550100")).toBe(false);
    }
  });
});

describe("per-number and hourly caps", () => {
  beforeEach(() => { _resetOtpGuard(); delete process.env.OTP_HOURLY_CAP; delete process.env.OTP_DAILY_PER_PHONE; });
  afterEach(() => { _resetOtpGuard(); delete process.env.OTP_HOURLY_CAP; delete process.env.OTP_DAILY_PER_PHONE; });

  it("allows 8 codes per number per day, then refuses until 24 hours pass", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 8; i++) expect(checkOtpSend("+14035550100", { now: t0 + i * 10 * 60 * 1000 })).toEqual({ ok: true });
    expect(checkOtpSend("+14035550100", { now: t0 + 90 * 60 * 1000 })).toEqual({ ok: false, reason: "otp_phone_daily_limit" });
    expect(checkOtpSend("+14035550101", { now: t0 + 90 * 60 * 1000 })).toEqual({ ok: true });
    expect(checkOtpSend("+14035550100", { now: t0 + 25 * 60 * 60 * 1000 })).toEqual({ ok: true });
  });
  it("pauses every number once the hourly cap is reached, then recovers", () => {
    process.env.OTP_HOURLY_CAP = "5";
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) expect(checkOtpSend("+1403555010" + i, { now: t0 })).toEqual({ ok: true });
    expect(checkOtpSend("+14035550199", { now: t0 + 1000 })).toEqual({ ok: false, reason: "otp_busy" });
    expect(checkOtpSend("+14035550199", { now: t0 + 61 * 60 * 1000 })).toEqual({ ok: true });
  });
  it("lets a staff number through the caps but never through the country check", () => {
    process.env.OTP_HOURLY_CAP = "1";
    const t0 = 1_000_000_000_000;
    expect(checkOtpSend("+14035550100", { now: t0 })).toEqual({ ok: true });
    expect(checkOtpSend("+14035550111", { now: t0 })).toEqual({ ok: false, reason: "otp_busy" });
    expect(checkOtpSend("+14035550111", { now: t0, trusted: true })).toEqual({ ok: true });
    expect(checkOtpSend("+18765550100", { now: t0, trusted: true })).toEqual({ ok: false, reason: "unsupported_country" });
  });
  it("gives a clear message and the right status for each refusal", () => {
    expect(OTP_GUARD_MESSAGES.unsupported_country).toContain("Canadian or US");
    expect(OTP_GUARD_STATUS.unsupported_country).toBe(400);
    expect(OTP_GUARD_STATUS.otp_busy).toBe(429);
    expect(OTP_GUARD_STATUS.otp_phone_daily_limit).toBe(429);
  });
});

describe("the rate limit cannot be dodged with a forged X-Forwarded-For", () => {
  const req = (xff: string | undefined, ip = "10.0.0.1") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, ip, socket: {} }) as any;
  it("uses the address Azure appended (last), not the one the caller wrote (first)", () => {
    expect(clientIpForRateLimit(req("1.2.3.4, 77.246.52.163:62553"))).toBe("77.246.52.163");
    expect(clientIpForRateLimit(req("9.9.9.9, 8.8.8.8, 77.246.52.163"))).toBe("77.246.52.163");
  });
  it("skips an internal proxy hop after the caller", () => {
    expect(clientIpForRateLimit(req("1.2.3.4, 77.246.52.163:62553, 10.0.0.4"))).toBe("77.246.52.163");
    expect(clientIpForRateLimit(req("77.246.52.163, 172.16.5.1, 192.168.1.9"))).toBe("77.246.52.163");
  });
  it("still works with a single entry or none", () => {
    expect(clientIpForRateLimit(req("77.246.52.163:62553"))).toBe("77.246.52.163");
    expect(clientIpForRateLimit(req(undefined, "77.246.52.164"))).toBe("77.246.52.164");
  });
});

describe("the live routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/_int", intRouter);
  const start = (phone: string) => request(app).post("/api/auth/otp/start").send({ phone });

  beforeEach(() => {
    _resetOtpGuard();
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([]));
    h.checkTextable.mockReset();
    h.checkTextable.mockResolvedValue({ ok: true });
    h.verifyCreate.mockReset();
    h.verifyCreate.mockResolvedValue({ status: "pending" });
    h.twilioFactory.mockReset();
  });
  afterEach(() => { _resetOtpGuard(); vi.unstubAllEnvs(); });

  it("checks the guard before Lookup and before Verify", async () => {
    // A refused country never reaches the paid Lookup or Verify calls.
    const foreign = await start("+18765550100");
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("unsupported_country");
    expect(h.checkTextable).not.toHaveBeenCalled();
    expect(h.verifyCreate).not.toHaveBeenCalled();

    // An allowed number goes guard -> Lookup -> Verify...
    for (let i = 0; i < 8; i++) expect((await start("+14035550100")).status).toBe(200);
    expect(h.checkTextable).toHaveBeenCalledTimes(8);
    expect(h.verifyCreate).toHaveBeenCalledTimes(8);
    expect(h.verifyCreate).toHaveBeenLastCalledWith({ to: "+14035550100", channel: "sms" });

    // ...until the per-number cap, which refuses before either paid call.
    const capped = await start("+14035550100");
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe("otp_phone_daily_limit");
    expect(capped.headers["retry-after"]).toBe("3600");
    expect(h.checkTextable).toHaveBeenCalledTimes(8);
    expect(h.verifyCreate).toHaveBeenCalledTimes(8);
  });

  it("the Twilio test send needs a signed-in user", async () => {
    const anon = await request(app).post("/api/_int/twilio-test").send({});
    expect(anon.status).toBe(401);
    expect(h.twilioFactory).not.toHaveBeenCalled();
    const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    vi.stubEnv("TWILIO_TEST_TO", "+14035550100");
    h.twilioFactory.mockReturnValue({ verify: { v2: { services: () => ({ verifications: { create: async () => ({ status: "pending" }) } }) } } });
    const signedIn = await request(app).post("/api/_int/twilio-test").set("Authorization", "Bearer " + token).send({});
    expect(signedIn.status).toBe(200);
    expect(h.twilioFactory).toHaveBeenCalledTimes(1);
  });
});
