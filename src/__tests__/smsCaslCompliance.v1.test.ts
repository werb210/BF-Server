import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter } from "./helpers/staffRouterApp.js";

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
vi.mock("../services/fraud/fraudGuard.js", async () => ({
  ...(await vi.importActual<any>("../services/fraud/fraudGuard.js")),
  contactHasFraudApplication: async () => false,
}));
vi.mock("../modules/automation/automationEngine.js", async () => ({
  ...(await vi.importActual<any>("../modules/automation/automationEngine.js")),
  emitAutomationEvent: async () => undefined,
}));

import { renderMarketingSms } from "../services/marketingSms.js";

const FOOTER = "Reply STOP to opt out. Info: www.boreal.financial/sms";

async function inbound(body: string, from = "+14035550123") {
  const app = mountRouter((await import("../routes/smsInboundWebhook.js")).default, "/api");
  return request(app).post("/api/webhooks/twilio/sms-inbound").type("form").send({ From: from, To: "+18666318939", Body: body, MessageSid: "SM1" });
}

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.sendSms.mockReset().mockResolvedValue({ ok: true, sid: "SMx" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("SMS CASL compliance", () => {
  it("inbound STOP sets sms_opt_out and confirms", async () => {
    const res = await inbound("Stop");
    expect(res.text).toContain("<Message>Boreal Financial: You've been unsubscribed");
    const [update] = callsMatching(h.query, /UPDATE contacts SET sms_opt_out = \$2/);
    expect(update[1]).toEqual(["4035550123", true]);
    // Nothing else happens for a STOP: it is not stored as a conversation message.
    expect(callsMatching(h.query, /INSERT INTO communications_messages/)).toHaveLength(0);
  });

  it("an ordinary inbound text resolves its contact within the BF silo", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM communications_conversations/, { rowCount: 1, rows: [{ id: "conv-1" }] }],
      [/WITH matched AS/, { rows: [{ id: "ct-1" }] }],
    ]));
    await inbound("Thanks, I'll send the statements");
    const [resolve] = callsMatching(h.query, /WITH matched AS/);
    expect(String(resolve[0])).toContain("WHERE silo = 'BF'");
    expect(callsMatching(h.query, /INSERT INTO communications_messages/)[0][1]).toEqual(expect.arrayContaining(["conv-1", "ct-1"]));
  });

  // BF_SERVER_SMS_MERGE_FIELDS_v1 - the footer lives once, in renderMarketingSms(), and
  // every marketing SMS path renders through it.
  it("marketing SMS auto-appends opt-out + Info", () => {
    // The footer is the last element of the rendered message, after any link.
    expect(renderMarketingSms({ body: "Hi {{first_name}}", vars: { first_name: "Ada" }, link: "https://x.test/r/1" }))
      .toBe(`Hi Ada https://x.test/r/1 ${FOOTER}`);
    expect(renderMarketingSms({ body: "Hi", vars: {} }))
      .toBe(`Hi ${FOOTER}`);
  });

  it("the blast runner cannot bypass the footer", async () => {
    const { runSmsSend } = await import("../services/marketingSendRunner.js");
    const pool = { query: vi.fn(answerBySql([
      [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
      [/FROM contacts c LEFT JOIN companies co/, { rows: [{ id: "c1", email: null, phone: "+14035550123", name: "Ada Lovelace", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" }] }],
      [/INSERT INTO sms_campaign_sends/, { rows: [{ id: "send-1" }] }],
    ])) };
    const out = await runSmsSend(pool as any, { silo: "BF", tag: null, body: "Hi {{first_name}}", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null });
    expect(out.smsSent).toBe(1);
    expect(h.sendSms).toHaveBeenCalledWith("+14035550123", `Hi Ada ${FOOTER}`);
  });

  it("the sequence engine cannot bypass the footer", async () => {
    const { tickSequences } = await import("../services/sequenceEngine.js");
    let claimed = 0;
    const pool = { query: vi.fn(answerBySql([
      [/SET status='running'/, () => ({ rows: claimed++ === 0 ? [{ id: "en-1", sequence_id: "seq-1", contact_id: "c1", current_step: 0, enrolled_at: new Date(), last_step_at: null, stop_on_reply: false, quiet_start: null, quiet_end: null }] : [] })],
      [/FROM marketing_sequence_steps/, { rows: [{ channel: "sms", body: "Hello {{first_name}}", link_url: null, condition: null }] }],
      [/FROM contacts WHERE id=\$1/, { rows: [{ id: "c1", silo: "BF", phone: "+14035550123", name: "Ada Lovelace", sms_opt_out: false, marketing_opt_out: false, sms_consent: true, line_type: "mobile" }] }],
      [/INSERT INTO sequence_sends/, { rows: [{ id: "ss-1" }] }],
    ])) };
    await tickSequences(pool as any);
    expect(h.sendSms).toHaveBeenCalledWith("+14035550123", `Hello Ada ${FOOTER}`);
  });
});
