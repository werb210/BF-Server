// BF_SERVER_US_SMS_TOLLFREE_v755
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { isUsNumber, smsFromFor, DEFAULT_US_SMS_FROM } from "../lib/smsFrom.js";

const LOCAL = "+18254511768";

describe("texts to US numbers go out from the toll-free line", () => {
  afterEach(() => { delete process.env.TWILIO_US_SMS_FROM; });
  it("tells US numbers from Canadian and Caribbean ones", () => {
    expect(isUsNumber("+19173043342")).toBe(true);  // New York (Brandon Voss)
    expect(isUsNumber("+18184157968")).toBe(true);  // Los Angeles
    expect(isUsNumber("(212) 555-0100")).toBe(true);
    expect(isUsNumber("+17873000000")).toBe(true);  // Puerto Rico is US
    expect(isUsNumber("+15878881837")).toBe(false); // Calgary
    expect(isUsNumber("+14165550100")).toBe(false); // Toronto
    expect(isUsNumber("+18765550100")).toBe(false); // Jamaica
    expect(isUsNumber("+447700900000")).toBe(false);
    expect(isUsNumber("")).toBe(false);
  });
  it("uses the 866 for US recipients and the local number for everyone else", () => {
    expect(DEFAULT_US_SMS_FROM).toBe("+18666318939");
    expect(smsFromFor("+19173043342", LOCAL)).toBe("+18666318939");
    expect(smsFromFor("+15878881837", LOCAL)).toBe(LOCAL);
  });
  it("can be pointed elsewhere or switched off without code", () => {
    process.env.TWILIO_US_SMS_FROM = "+18005550199";
    expect(smsFromFor("+19173043342", LOCAL)).toBe("+18005550199");
    process.env.TWILIO_US_SMS_FROM = "off";
    expect(smsFromFor("+19173043342", LOCAL)).toBe(LOCAL);
  });
  it("is wired into the transactional senders and kept out of marketing and bulk sends", () => {
    for (const f of ["src/modules/notifications/sms.service.ts", "src/services/smsService.ts", "src/lib/twilio.ts", "src/routes/communications.ts", "src/routes/auth/otp.ts", "src/routes/portal.ts"]) {
      expect(readFileSync(f, "utf8"), f).toContain("smsFromFor(");
    }
    expect(readFileSync("src/services/marketingSms.ts", "utf8")).not.toContain("smsFromFor(");
    expect(readFileSync("src/routes/communications.ts", "utf8")).toContain("const msg = await client.messages.create({ body: String(mergedBody), from, to });");
  });
});
