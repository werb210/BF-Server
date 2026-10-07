// BF_SERVER_RCS_SENDER_v770
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { smsSenderFor } from "../lib/smsFrom.js";

const SID = "MG" + "a".repeat(32);
afterEach(() => { delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID; delete process.env.TWILIO_US_SMS_FROM; });

describe("branded (RCS) texting through a Messaging Service", () => {
  it("unchanged when no Messaging Service is configured: local number for Canada, 866 for the US", () => {
    expect(smsSenderFor("+15878881837", "+15875550100")).toEqual({ from: "+15875550100" });
    expect(smsSenderFor("+19173043342", "+15875550100")).toEqual({ from: "+18666318939" });
  });
  it("sends through the Messaging Service when TWILIO_RCS_MESSAGING_SERVICE_SID is a valid MG sid", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    expect(smsSenderFor("+15878881837", "+15875550100")).toEqual({ messagingServiceSid: SID });
    expect(smsSenderFor("+19173043342", "+15875550100")).toEqual({ messagingServiceSid: SID });
  });
  it("ignores a malformed value instead of breaking texting", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = "not-a-sid";
    expect(smsSenderFor("+15878881837", "+15875550100")).toEqual({ from: "+15875550100" });
  });
  it("transactional senders use it; marketing and bulk sends do not", () => {
    for (const f of ["src/lib/twilio.ts", "src/services/smsService.ts", "src/routes/portal.ts", "src/routes/auth/otp.ts", "src/modules/notifications/sms.service.ts"]) {
      expect(readFileSync(f, "utf8"), f).toContain("...smsSenderFor(");
    }
    expect(readFileSync("src/routes/communications.ts", "utf8")).toContain("...smsSenderFor(String(to), from)");
    expect(readFileSync("src/services/marketingSms.ts", "utf8")).not.toContain("smsSenderFor(");
  });
});
