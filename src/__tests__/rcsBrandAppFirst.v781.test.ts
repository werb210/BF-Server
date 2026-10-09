// BF_SERVER_RCS_BRAND_BF_ONLY_v781 / BF_SERVER_SBA_NOTICE_APP_FIRST_v781 / BF_SERVER_SBA_READINESS_v781
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { smsSenderFor } from "../lib/smsFrom.js";

const MG = "MG" + "0123456789abcdef0123456789abcdef";
afterEach(() => { delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID; });

describe("the Boreal Financial RCS brand is used for Boreal Financial only", () => {
  it("Financial texts use the RCS Messaging Service once it is set", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = MG;
    expect(smsSenderFor("+17805550100", "+18254511768")).toEqual({ messagingServiceSid: MG });
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "BF" })).toEqual({ messagingServiceSid: MG });
  });
  it("Insurance texts stay plain SMS from the normal number", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = MG;
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "BI" })).toEqual({ from: "+18254511768" });
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "bi" })).toEqual({ from: "+18254511768" });
  });
  it("BI-Server's text bridge and staff texts in the Insurance silo pass their silo", () => {
    expect(readFileSync("src/routes/serviceBridge.ts", "utf8")).toContain('await sendSMS(to, body, { silo: "BI" });');
    expect(readFileSync("src/routes/communications.ts", "utf8")).toContain("smsSenderFor(String(to), from, { silo: senderSilo })");
  });
});

describe("SBA ready-to-sign notice and banner", () => {
  it("tries the Boreal app before texting owner 1", () => {
    const s = readFileSync("src/signnow/sba/sbaTrigger.ts", "utf8");
    const app = s.indexOf("await pushToClientApp("), text = s.indexOf("ready to sign. Sign in at");
    expect(app).toBeGreaterThan(0);
    expect(app).toBeLessThan(text);
    expect(s).toContain("if (!inApp) {");
  });
  // BF_SERVER_SBA_ONE_BUTTON_v789 - superseded: an SBA file now saves its lender first (the 4506-C names it) and
  // signs from the same Send as every other file, so "no lender finalized" is the right message again.
  it("SBA files get their own readiness states on top of the normal ones", () => {
    const s = readFileSync("src/modules/applications/applications.routes.ts", "utf8");
    expect(s).toContain("if (reason === 'ready') reason = await sbaReadinessReason(id, reason);");
    expect(s).not.toContain("reason = 'sba_use_sba_signing'");
  });
});
