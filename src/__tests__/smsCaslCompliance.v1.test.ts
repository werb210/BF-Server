import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarketingSms } from "../services/marketingSms.js";

const wh = readFileSync(join(process.cwd(), "src", "routes", "smsInboundWebhook.ts"), "utf-8");
const runner = readFileSync(join(process.cwd(), "src", "services", "marketingSendRunner.ts"), "utf-8");
const sequence = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
const sms = readFileSync(join(process.cwd(), "src", "services", "marketingSms.ts"), "utf-8");

describe("SMS CASL compliance", () => {
  it("inbound STOP sets sms_opt_out scoped to silo and confirms", () => {
    expect(wh).toContain("BF_SERVER_SMS_STOP_HANDLER_v1");
    expect(wh).toContain('"STOP"');
    expect(wh).toContain("sms_opt_out = $2");
    expect(wh).toContain("WHERE silo = 'BF'");
  });

  // BF_SERVER_SMS_MERGE_FIELDS_v1 - the footer literal used to live inline in the
  // blast runner, and this test asserted on that copy. The footer now lives once, in
  // renderMarketingSms(), because the runner was ALSO shipping unmerged {{tokens}}.
  // Asserting on the string's old location would now pass only by keeping a
  // duplicate, so assert the invariant that actually matters: the footer is defined
  // once, and every marketing SMS path renders through the helper that appends it.
  it("marketing SMS auto-appends opt-out + Info", () => {
    expect(sms).toContain("Reply STOP to opt out. Info: www.boreal.financial/sms");
    expect(sms).toContain("CASL_FOOTER");
    // The footer is the last element of the rendered message, after any link.
    expect(renderMarketingSms({ body: "Hi {{first_name}}", vars: { first_name: "Ada" }, link: "https://x.test/r/1" }))
      .toBe("Hi Ada https://x.test/r/1 Reply STOP to opt out. Info: www.boreal.financial/sms");
    expect(renderMarketingSms({ body: "Hi", vars: {} }))
      .toBe("Hi Reply STOP to opt out. Info: www.boreal.financial/sms");
  });

  it("no marketing SMS path can bypass the footer", () => {
    expect(runner).toContain("renderMarketingSms({");
    expect(sequence).toContain("renderMarketingSms({");
  });
});
