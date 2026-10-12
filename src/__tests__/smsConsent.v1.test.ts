// BF_SERVER_SMS_CONSENT_v1
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter } from "./helpers/staffRouterApp.js";
import { isCanadianMobile, CONSENT_SQL, SMS_ELIGIBLE_SQL } from "../services/smsConsent";

const h = vi.hoisted(() => ({ query: vi.fn(), sendSms: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../services/marketingSms.js", async () => ({
  ...(await vi.importActual<any>("../services/marketingSms.js")),
  sendMarketingSms: h.sendSms,
  lookupLineType: async () => "mobile",
}));

const migration = readFileSync(path.join(process.cwd(), "migrations/2026_07_14_sms_consent.sql"), "utf8");

type Row = { id: string; email: string | null; phone: string; name: string; company: null; sms_ok: boolean; marketing_opt_out: boolean; line_type: string };
const row = (id: string, phone: string, extra: Partial<Row> = {}): Row =>
  ({ id, email: null, phone, name: "Pat", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile", ...extra });

function runnerPool(recipients: Row[]) {
  let send = 0;
  return {
    query: vi.fn(answerBySql([
      [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
      [/FROM contacts c/, { rows: recipients }],
      [/INSERT INTO sms_campaign_sends/, () => ({ rows: [{ id: `send-${++send}` }] })],
    ])),
  };
}

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.sendSms.mockReset().mockResolvedValue({ ok: true, sid: "SMx" });
});

describe("Canada-only", () => {
  it("accepts Canadian area codes", () => {
    expect(isCanadianMobile("+14035550123")).toBe(true);  // 587 Calgary
    expect(isCanadianMobile("+14165096200")).toBe(true);  // 416 Toronto
    expect(isCanadianMobile("778-928-2886")).toBe(true);  // 778 BC
  });
  it("rejects US numbers -- a +1 number is not automatically Canadian", () => {
    expect(isCanadianMobile("+12125551234")).toBe(false); // 212 New York
    expect(isCanadianMobile("+13105551234")).toBe(false); // 310 Los Angeles
  });
  it("rejects malformed input rather than guessing", () => {
    expect(isCanadianMobile(null)).toBe(false);
    expect(isCanadianMobile("")).toBe(false);
    expect(isCanadianMobile("12345")).toBe(false);
  });
});

describe("CASL consent gating", () => {
  it("implied consent expires: 6 months on an inquiry, 2 years on a transaction", () => {
    expect(CONSENT_SQL).toContain("interval '6 months'");
    expect(CONSENT_SQL).toContain("interval '2 years'");
  });
  it("express consent has no expiry", () => {
    expect(CONSENT_SQL).toContain("c.sms_consent");
  });
  it("eligibility requires consent, no opt-out of SMS *or* marketing, and a mobile", () => {
    expect(SMS_ELIGIBLE_SQL).toContain("sms_opt_out");
    expect(SMS_ELIGIBLE_SQL).toContain("marketing_opt_out");
    expect(SMS_ELIGIBLE_SQL).toContain("line_type");
  });
});

describe("the send honours it", () => {
  it("marketing_opt_out is now checked on the SMS path, and only Canadian mobiles are texted", async () => {
    const { runSmsSend } = await import("../services/marketingSendRunner.js");
    const pool = runnerPool([
      row("ok", "+14035550123"),
      row("opted-out", "+14035550124", { marketing_opt_out: true }),
      row("us", "+12125551234"),
    ]);
    const out = await runSmsSend(pool as any, { silo: "BF", tag: null, body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null });
    expect(out.smsSent).toBe(1);
    expect(h.sendSms.mock.calls.map((c) => c[0])).toEqual(["+14035550123"]);
  });

  it("the recipient query and the count both use the same eligibility rule", async () => {
    const { runSmsSend, countSmsRecipients } = await import("../services/marketingSendRunner.js");
    const send = runnerPool([]);
    await runSmsSend(send as any, { silo: "BF", tag: null, body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null });
    const count = runnerPool([]);
    await countSmsRecipients(count as any, "BF", null);
    for (const pool of [send, count]) {
      const [recipients] = callsMatching(pool.query, /FROM contacts c/);
      expect(String(recipients[0])).toContain(SMS_ELIGIBLE_SQL.trim());
    }
  });

  it("supports include and exclude tags like the email composer", async () => {
    const { runSmsSend } = await import("../services/marketingSendRunner.js");
    const pool = runnerPool([]);
    await runSmsSend(pool as any, { silo: "BF", tag: null, body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null, tags: ["vip"], excludeTags: ["do_not_text"] });
    const [recipients] = callsMatching(pool.query, /FROM contacts c/);
    expect(String(recipients[0])).toContain("NOT (c.tags && $4::text[])");
    expect(recipients[1]).toEqual(["BF", null, ["vip"], ["do_not_text"]]);
  });
});

describe("STOP applies everywhere", () => {
  it("the opt-out UPDATE is no longer scoped to silo = 'BF' -- a BI contact's STOP was ignored", async () => {
    // Contact *resolution* stays BF-scoped (this is the BF inbound number); only the
    // opt-out write must span silos, because a person saying STOP means stop everywhere.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const app = mountRouter((await import("../routes/smsInboundWebhook.js")).default, "/api");
    await request(app).post("/api/webhooks/twilio/sms-inbound").type("form").send({ From: "+14035550123", Body: "STOP" });
    const [update] = callsMatching(h.query, /UPDATE contacts SET sms_opt_out/);
    expect(update[1]).toEqual(["4035550123", true]);
    expect(String(update[0])).not.toMatch(/silo/);
  });
});

describe("migration", () => {
  it("records the consent basis and backfills it from real application history", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS consent_basis");
    expect(migration).toContain("application_contacts");
    expect(migration).toContain("implied_inquiry");
  });
});
