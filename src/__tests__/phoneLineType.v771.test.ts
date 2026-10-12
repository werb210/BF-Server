// BF_SERVER_PHONE_LINE_TYPE_v771 / BF_SERVER_SHORT_LINKS_v771
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { checkTextable, interpretLookup, _clearLineTypeCache, NOT_TEXTABLE_MESSAGES } from "../lib/phoneLineType.js";
import { smsSenderFor } from "../lib/smsFrom.js";

const h = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
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

const answer = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;

describe("sign-in codes only go to numbers that can receive texts", () => {
  beforeEach(() => { _clearLineTypeCache(); process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "tok"; delete process.env.TWILIO_LOOKUP_LINE_TYPE; });
  afterEach(() => { delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_LOOKUP_LINE_TYPE; });

  it("reads Lookup answers: landline and invalid are refused, mobile and VoIP pass", () => {
    expect(interpretLookup({ valid: true, line_type_intelligence: { type: "landline" } })).toEqual({ ok: false, reason: "landline" });
    expect(interpretLookup({ valid: false })).toEqual({ ok: false, reason: "invalid" });
    expect(interpretLookup({ valid: true, line_type_intelligence: { type: "mobile" } })).toEqual({ ok: true });
    expect(interpretLookup({ valid: true, line_type_intelligence: { type: "nonFixedVoip" } })).toEqual({ ok: true });
    expect(interpretLookup({ valid: true })).toEqual({ ok: true });
  });
  it("refuses a landline and caches the answer", async () => {
    let calls = 0;
    const f = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ valid: true, line_type_intelligence: { type: "landline" } }) }; }) as unknown as typeof fetch;
    expect(await checkTextable("+14035550100", f)).toEqual({ ok: false, reason: "landline" });
    expect(await checkTextable("+14035550100", f)).toEqual({ ok: false, reason: "landline" });
    expect(calls).toBe(1);
  });
  it("fails open when Lookup errors, so nobody is locked out", async () => {
    expect(await checkTextable("+14035550101", answer({}, false))).toEqual({ ok: true });
    const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await checkTextable("+14035550102", boom)).toEqual({ ok: true });
  });
  it("can be switched off", async () => {
    process.env.TWILIO_LOOKUP_LINE_TYPE = "off";
    expect(await checkTextable("+14035550103", answer({ valid: false }))).toEqual({ ok: true });
  });
  describe("the live sign-in route checks before asking Verify for a code and returns a clear message", () => {
    const lookups: string[] = [];
    function stubLookup(type: string) {
      vi.stubGlobal("fetch", (async (url: string) => {
        lookups.push(String(url));
        if (String(url).startsWith("https://lookups.twilio.com/v2/PhoneNumbers/")) {
          return { ok: true, status: 200, json: async () => ({ valid: true, line_type_intelligence: { type } }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as unknown as typeof fetch);
    }
    beforeEach(async () => {
      lookups.length = 0;
      // checkTextable skips the real Lookup under NODE_ENV=test; this exercises the deployed path.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
      h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
      h.verificationCreate.mockReset().mockResolvedValue({ status: "pending" });
      (await import("../lib/otpGuard.js"))._resetOtpGuard();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    const start = async (phone: string) =>
      request(await (await import("./helpers/otpVerifyApp.js")).otpApp()).post("/api/auth/otp/start").send({ phone });

    it("a landline gets a clear 400 and no Verify code", async () => {
      stubLookup("landline");
      const res = await start("+14035550110");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "landline_number", message: NOT_TEXTABLE_MESSAGES.landline });
      expect(NOT_TEXTABLE_MESSAGES.landline).toContain("mobile number");
      expect(lookups).toHaveLength(1);
      expect(h.verificationCreate).not.toHaveBeenCalled();
    });

    it("a mobile is looked up first, then sent a Verify code", async () => {
      stubLookup("mobile");
      const res = await start("+14035550111");
      expect(res.status).toBe(200);
      expect(lookups[0]).toContain(encodeURIComponent("+14035550111"));
      expect(h.verificationCreate).toHaveBeenCalledWith({ to: "+14035550111", channel: "sms" });
    });
  });
});

describe("short links through the Messaging Service", () => {
  const SID = "MG" + "b".repeat(32);
  afterEach(() => { delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID; delete process.env.TWILIO_SHORTEN_LINKS; });
  it("asks Twilio to shorten links only when TWILIO_SHORTEN_LINKS=on and a Messaging Service is set", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    expect(smsSenderFor("+15875550100", "+15875550000")).toEqual({ messagingServiceSid: SID });
    process.env.TWILIO_SHORTEN_LINKS = "on";
    expect(smsSenderFor("+15875550100", "+15875550000")).toEqual({ messagingServiceSid: SID, shortenUrls: true });
    delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID;
    expect(smsSenderFor("+15875550100", "+15875550000")).toEqual({ from: "+15875550000" });
  });
});
