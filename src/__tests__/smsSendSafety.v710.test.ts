// BF_SERVER_SMS_SEND_SAFETY_v710
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planSmsAudience, phone10, type SmsAudienceRow } from "../services/marketingSendRunner.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
let n = 0;
const row = (o: Partial<SmsAudienceRow>): SmsAudienceRow => ({ id: "c" + (++n), email: null, phone: null, name: null, company: null, sms_ok: false, marketing_opt_out: false, line_type: null, ...o });

describe("who a campaign texts", () => {
  it("texts only consented Canadian mobiles, never an email-only contact", () => {
    const rows = [row({ phone: "+14035550101", sms_ok: true }), row({ phone: "+14035550102", sms_ok: false, email: "b@x.com" }), row({ phone: "+12125550103", sms_ok: true, email: "c@x.com" }), row({ phone: "+14035550104", sms_ok: true, line_type: "landline" })];
    const plan = planSmsAudience(rows, true);
    expect(plan.text.map((r) => r.phone)).toEqual(["+14035550101"]);
    expect(plan.email.map((r) => r.email)).toEqual(["b@x.com", "c@x.com"]);
  });
  it("without a fallback email, people who cannot be texted get nothing", () => {
    const plan = planSmsAudience([row({ phone: "+14035550102", sms_ok: false, email: "b@x.com" })], false);
    expect(plan.text).toEqual([]); expect(plan.email).toEqual([]);
  });
  it("one text per phone number, however many contact records share it", () => {
    expect(planSmsAudience([row({ phone: "+1 (403) 555-0101", sms_ok: true }), row({ phone: "4035550101", sms_ok: true }), row({ phone: "+14035550101", sms_ok: true })], false).text).toHaveLength(1);
  });
  it("one fallback email per address", () => { expect(planSmsAudience([row({ email: "A@x.com" }), row({ email: "a@x.com " })], true).email).toHaveLength(1); });
  it("honours the marketing opt-out on both channels", () => {
    const plan = planSmsAudience([row({ phone: "+14035550101", sms_ok: true, marketing_opt_out: true, email: "a@x.com" })], true);
    expect(plan.text).toEqual([]); expect(plan.email).toEqual([]);
  });
  it("skips phones already texted (resumed job, or a text in the last 24 hours)", () => {
    const plan = planSmsAudience([row({ phone: "+14035550101", sms_ok: true }), row({ phone: "+14035550199", sms_ok: true })], false, new Set([phone10("+14035550101")]));
    expect(plan.text.map((r) => r.phone)).toEqual(["+14035550199"]);
  });
});

describe("send path wiring", () => {
  const runner = read("../services/marketingSendRunner.ts"); const route = read("../routes/marketing.ts"); const worker = read("../workers/sendQueueWorker.ts"); const maya = read("../routes/mayaStaff.ts");
  it("the send and the count share one planner", () => { expect(runner.match(/planSmsAudience\(/g)?.length).toBeGreaterThanOrEqual(3); expect(runner).not.toContain("let hasPhone = Boolean(c.phone) && !c.sms_opt_out"); });
  it("every portal SMS campaign is queued with the hold; none send inside the request", () => { const send = route.slice(route.indexOf('router.post("/sms/send"'), route.indexOf('router.get("/sms/audience-count"')); expect(send).not.toContain("runSmsSend("); expect(send).toContain("INSERT INTO marketing_send_jobs"); expect(send).toContain("audience_changed"); });
  it("Maya's confirmed SMS send is queued too", () => { expect(maya).not.toMatch(/await runSmsSend\(pool, \{ silo, tag, body/); expect(maya).toContain("BF_SERVER_SMS_SEND_SAFETY_v710"); });
  it("the queue keeps the chosen tags and resumes its own campaign", () => { expect(worker).toContain("tags: (p.tags as string[] | undefined) ?? null"); expect(worker).toContain("excludeTags: (p.excludeTags as string[] | undefined) ?? null"); expect(worker).toContain("campaignId: (p as any).campaignId ?? null"); });
});
