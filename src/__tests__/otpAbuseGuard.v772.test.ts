// BF_SERVER_OTP_ABUSE_GUARD_v772
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { isAllowedOtpDestination, checkOtpSend, _resetOtpGuard, OTP_GUARD_MESSAGES, OTP_GUARD_STATUS } from "../lib/otpGuard.js";
import { clientIpForRateLimit } from "../middleware/authRateLimit.js";

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
  const auth = readFileSync("src/routes/auth.ts", "utf8");
  it("checks the guard before Lookup and before Verify", () => {
    const g = auth.indexOf("let guard = checkOtpSend(phone);");
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(auth.indexOf("await checkTextable(phone)"));
    expect(g).toBeLessThan(auth.indexOf("const verification = await client.verify.v2"));
  });
  it("the Twilio test send needs a signed-in user", () => {
    const intRoutes = readFileSync("src/routes/_int.ts", "utf8");
    expect(intRoutes).toMatch(/"\/twilio-test",\s*requireAuth,/);
  });
});
