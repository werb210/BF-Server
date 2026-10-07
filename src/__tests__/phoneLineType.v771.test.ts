// BF_SERVER_PHONE_LINE_TYPE_v771 / BF_SERVER_SHORT_LINKS_v771
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { checkTextable, interpretLookup, _clearLineTypeCache, NOT_TEXTABLE_MESSAGES } from "../lib/phoneLineType.js";
import { smsSenderFor } from "../lib/smsFrom.js";

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
  it("the live sign-in route checks before asking Verify for a code and returns a clear message", () => {
    const src = readFileSync("src/routes/auth.ts", "utf8");
    expect(src.indexOf("await checkTextable(phone)")).toBeGreaterThan(0);
    expect(src.indexOf("await checkTextable(phone)")).toBeLessThan(src.indexOf("const verification = await client.verify.v2"));
    expect(NOT_TEXTABLE_MESSAGES.landline).toContain("mobile number");
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
