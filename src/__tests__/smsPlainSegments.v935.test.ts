// BF_SERVER_v935_SMS_PLAIN_SEGMENTS
import { describe, expect, it } from "vitest";
import { plainSmsText, renderMarketingSms, smsSegments } from "../services/marketingSms.js";

describe("plain SMS text", () => {
  it("swaps curly quotes, dashes and ellipses for plain ones", () => {
    expect(plainSmsText("it’s “new” – now… ok")).toBe(`it's "new" - now... ok`);
  });
  it("one curly quote no longer makes the text UCS-2", () => {
    const body = "Hi {{first_name}}, it’s Boreal Financial. Canada’s new 100% equipment write-off could save your business real money if the equipment is in use by Dec 31. Here’s how it works:";
    const text = renderMarketingSms({ body, vars: { first_name: "Jo" }, link: "https://server.boreal.financial/api/r/s/AbCd2345" });
    const s = smsSegments(text);
    expect(s.encoding).toBe("GSM-7");
    expect(s.segments).toBeLessThanOrEqual(2);
    expect(smsSegments("it’s").encoding).toBe("UCS-2");
  });
  it("adds the opt-out line once", () => {
    const t = renderMarketingSms({ body: "Hello. Reply STOP to opt out.", vars: {} });
    expect(t.match(/STOP/g)?.length).toBe(1);
    expect(t).toContain("Info: www.boreal.financial/sms");
    expect(renderMarketingSms({ body: "Hello.", vars: {} })).toContain("Reply STOP to opt out.");
    // a merged company name containing STOP does not remove the opt-out line
    expect(renderMarketingSms({ body: "Hi {{company}}, save on equipment.", vars: { company: "STOP Logistics" } })).toContain("Reply STOP to opt out.");
  });
  it("counts segments like Twilio", () => {
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("a".repeat(306)).segments).toBe(2);
    expect(smsSegments("€".repeat(80)).segments).toBe(1);
    expect(smsSegments("é".repeat(10)).encoding).toBe("GSM-7");
    expect(smsSegments("✓".repeat(70)).segments).toBe(1);
    expect(smsSegments("✓".repeat(71)).segments).toBe(2);
  });
});
