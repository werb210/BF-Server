// BF_SERVER_v806_NO_PHONE_TO_ADS + BF_SERVER_v806_NO_MARKETING_FROM_TOLL_FREE
// Twilio rejected the 866 toll-free number as "third-party lead generation" (30468). What we tell the carriers
// must be true in the code: mobile numbers never go to advertisers, and marketing texts never leave from the
// toll-free number (it is verified for application messages only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn(async () => ({ sid: "SM1" })) }));
vi.mock("../twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: h.create } }) }));

import { userIdentifiersFor } from "../googleAdsEnhanced.js";
import { isTollFreeNumber, sendMarketingSms, smsMarketingConfigured } from "../marketingSms.js";

const env = { ...process.env };
beforeEach(() => { h.create.mockClear(); process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.JWT_SECRET = "0123456789abc"; });
afterEach(() => { process.env = { ...env }; });

describe("v806 what the carriers were told is what the code does", () => {
  it("never sends a phone number to Google, even with ad consent", () => {
    const ids = userIdentifiersFor("ann@acme.com", "(403) 555-1234", true);
    expect(ids).toHaveLength(1);
    expect(JSON.stringify(ids)).not.toContain("hashedPhoneNumber");
  });

  it("recognises toll-free numbers", () => {
    expect(isTollFreeNumber("+18666318939")).toBe(true);
    expect(isTollFreeNumber("(833) 555-0100")).toBe(true);
    expect(isTollFreeNumber("+15874165992")).toBe(false);
  });

  it("refuses to send marketing texts from the toll-free number", async () => {
    process.env.TWILIO_SMS_FROM = "+18666318939";
    expect(smsMarketingConfigured()).toBe(false);
    const r = await sendMarketingSms("+17804161234", "Hi");
    expect(r).toEqual({ ok: false, error: "toll_free_sender_not_allowed_for_marketing" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("sends marketing texts from a Canadian local number", async () => {
    process.env.TWILIO_SMS_FROM = "+15874165992";
    expect(smsMarketingConfigured()).toBe(true);
    const r = await sendMarketingSms("+17804161234", "Hi");
    expect(r.ok).toBe(true);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ from: "+15874165992", to: "+17804161234" }));
  });
});
