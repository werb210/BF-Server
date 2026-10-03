// BF_SERVER_SMS_AUDIENCES_v726
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SMS_AUDIENCES, SMS_AUDIENCE_SQL } from "../services/marketingSendRunner.js";

describe("SMS audiences", () => {
  it("has the two audiences no tag can express", () => {
    expect(SMS_AUDIENCES.map((a) => a.label)).toEqual(["Started, not submitted", "CBF past applicants"]);
  });
  it("started-not-submitted excludes anyone with a submitted application; CBF uses the consent source", () => {
    expect(SMS_AUDIENCE_SQL).toContain("'application_started' = ANY(c.tags)");
    expect(SMS_AUDIENCE_SQL).toContain("WHERE sa.submitted_at IS NOT NULL");
    expect(SMS_AUDIENCE_SQL).toContain("c.consent_source = 'CBF application terms'");
    expect(SMS_AUDIENCE_SQL).toContain("left($2, 6) <> '__aud:' AND $2 = ANY(c.tags)");
  });
  it("the count and the send both use it, so consent, one-per-phone and the hold still apply", () => {
    const src = readFileSync("src/services/marketingSendRunner.ts", "utf8");
    const sms = src.slice(src.indexOf("export async function countSmsRecipients("));
    expect(sms.match(/AND \$\{SMS_AUDIENCE_SQL\}/g)?.length).toBe(2);
    expect(readFileSync("src/routes/marketing.ts", "utf8")).toContain(").SMS_AUDIENCES,");
  });
});
