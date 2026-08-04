// BF_SERVER_SMS_CASCADE_COMPLETE_v12
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SMS_ELIGIBLE_SQL, EMAIL_FALLBACK_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL } from "../services/smsConsent.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const runner = read("../services/marketingSendRunner.ts");
const engine = read("../services/sequenceEngine.ts");
const sms = read("../services/marketingSms.ts");

describe("sms cascade completeness", () => {
  it("campaign eligibility is the union of both channels", () => {
    expect(CAMPAIGN_ELIGIBLE_SQL).toContain(SMS_ELIGIBLE_SQL.trim());
    expect(CAMPAIGN_ELIGIBLE_SQL).toContain(EMAIL_FALLBACK_ELIGIBLE_SQL);
    // A contact with no phone is unreachable by SMS but reachable by email.
    expect(SMS_ELIGIBLE_SQL).toContain("COALESCE(c.phone,'') <> ''");
    expect(EMAIL_FALLBACK_ELIGIBLE_SQL).not.toContain("c.phone");
  });

  it("email fallback still honours the marketing opt-out", () => {
    expect(EMAIL_FALLBACK_ELIGIBLE_SQL).toContain("COALESCE(c.marketing_opt_out, false) = false");
  });

  it("the send widens its audience only when a fallback email exists", () => {
    expect(runner).toContain("${job.fbHtml ? CAMPAIGN_ELIGIBLE_SQL : SMS_ELIGIBLE_SQL}");
  });

  it("the count widens on the same condition, so the number matches the send", () => {
    expect(runner).toContain("${hasFallback ? CAMPAIGN_ELIGIBLE_SQL : SMS_ELIGIBLE_SQL}");
    expect(runner).toContain("hasFallback = false");
    const route = read("../routes/marketing.ts");
    expect(route).toContain("countSmsRecipients(pool, silo, tag, includeTags, excludeTags, Boolean(fbHtml))");
  });

  it("a failed SMS send now cascades to email", () => {
    const fail = runner.slice(runner.indexOf("if (r.optedOut) await pool.query"));
    expect(fail).toContain('reason: "sms_send_failed"');
    // The dead send row must go, or the 36h worker chases a message never sent.
    expect(fail).toContain("DELETE FROM sms_campaign_sends WHERE id = $1");
    // A cascaded contact is not also counted as a failure.
    expect(fail).toContain("failed--");
  });

  it("an explicit sms sequence step falls back rather than vanishing", () => {
    expect(engine).toContain("const smsFallsBackToEmail =");
    expect(engine).toContain('if (channel === "sms" && !smsFallsBackToEmail) {');
    // Only when there is something to actually say.
    expect(engine).toContain("Boolean(c.email) && !c.marketing_opt_out");
  });

  it("tracked links read an env name that is actually deployed", () => {
    expect(sms).toContain("process.env.PUBLIC_BASE_URL");
    expect(sms).toContain("process.env.SERVER_URL");
  });
});
