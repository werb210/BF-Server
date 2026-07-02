import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wh = readFileSync(join(process.cwd(), "src", "routes", "smsInboundWebhook.ts"), "utf-8");
const runner = readFileSync(join(process.cwd(), "src", "services", "marketingSendRunner.ts"), "utf-8");

describe("SMS CASL compliance", () => {
  it("inbound STOP sets sms_opt_out scoped to silo and confirms", () => {
    expect(wh).toContain("BF_SERVER_SMS_STOP_HANDLER_v1");
    expect(wh).toContain('"STOP"');
    expect(wh).toContain("sms_opt_out = $2");
    expect(wh).toContain("WHERE silo = 'BF'");
  });

  it("marketing SMS auto-appends opt-out + Info", () => {
    expect(runner).toContain("Reply STOP to opt out. Info: boreal.financial/sms");
  });
});
