// BF_SERVER_v808_TOLLFREE_MARKETING - marketing texts come from the 866 only after Twilio approves marketing on
// it (TWILIO_TOLLFREE_MARKETING=on), and only to people who ticked the optional "Text me offers" box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn(async () => ({ sid: "SM1" })), query: vi.fn() }));
vi.mock("../twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: h.create } }) }));
vi.mock("../../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => h.query(sql, p) } }));

import { sendMarketingSms, smsMarketingConfigured } from "../marketingSms.js";

const env = { ...process.env };
const OPTED_IN = "7804161234";
beforeEach(() => {
  h.create.mockClear();
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, p?: unknown[]) =>
    /consent_source = 'marketing_sms_optin'/.test(sql) && p?.[0] === OPTED_IN ? { rows: [{ "?column?": 1 }] } : { rows: [] });
  process.env.TWILIO_ACCOUNT_SID = "AC1";
  process.env.JWT_SECRET = "0123456789abc";
  process.env.TWILIO_SMS_FROM = "+18666318939";
});
afterEach(() => { process.env = { ...env }; });

describe("v808 marketing from the toll-free number", () => {
  it("stays off until Twilio approves marketing on the 866", async () => {
    delete process.env.TWILIO_TOLLFREE_MARKETING;
    expect(smsMarketingConfigured()).toBe(false);
    expect(await sendMarketingSms("+1" + OPTED_IN, "Hi")).toEqual({ ok: false, error: "toll_free_sender_not_allowed_for_marketing" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("once approved, sends from the 866 to people who ticked the offers box", async () => {
    process.env.TWILIO_TOLLFREE_MARKETING = "on";
    expect(smsMarketingConfigured()).toBe(true);
    const r = await sendMarketingSms("+1" + OPTED_IN, "Hi");
    expect(r.ok).toBe(true);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ from: "+18666318939", to: "+1" + OPTED_IN }));
  });

  it("once approved, never texts someone who did not tick the offers box", async () => {
    process.env.TWILIO_TOLLFREE_MARKETING = "on";
    expect(await sendMarketingSms("+17804169999", "Hi")).toEqual({ ok: false, error: "no_marketing_optin" });
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("v808 the SMS screens count only opted-in people when marketing goes from the 866", () => {
  it("adds the opt-in condition only when the toll-free sender is approved for marketing", async () => {
    process.env.TWILIO_SMS_FROM = "+18666318939";
    delete process.env.TWILIO_TOLLFREE_MARKETING;
    vi.resetModules();
    expect((await import("../smsConsent.js")).SMS_ELIGIBLE_SQL).not.toContain("marketing_sms_optin");
    process.env.TWILIO_TOLLFREE_MARKETING = "on";
    vi.resetModules();
    expect((await import("../smsConsent.js")).SMS_ELIGIBLE_SQL).toContain("c.consent_source = 'marketing_sms_optin'");
    process.env.TWILIO_SMS_FROM = "+18254511768";
    vi.resetModules();
    expect((await import("../smsConsent.js")).SMS_ELIGIBLE_SQL).not.toContain("marketing_sms_optin");
  });
});
