// BF_SERVER_v850_KS_CRM - Keystone communications parity: an inbound text from someone who is only a Keystone contact
// lands on that contact's timeline (message silo KS) while a BF contact still wins and an unknown sender still becomes a
// BF contact; an email sent from Outlook to a Keystone contact is logged on the Keystone contact in the KS silo.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../../modules/automation/automationEngine.js", async () => ({
  ...(await vi.importActual<any>("../../modules/automation/automationEngine.js")),
  emitAutomationEvent: async () => undefined,
}));

const KS_CONTACT = "44444444-4444-4444-8444-444444444444";
const BF_CONTACT = "55555555-5555-4555-8555-555555555555";

async function inbound(rules: SqlRule[]) {
  h.query.mockImplementation(answerBySql([[/FROM communications_conversations/, { rowCount: 1, rows: [{ id: "conv-1" }] }], ...rules]));
  const app = mountRouter((await import("../smsInboundWebhook.js")).default, "/api");
  await request(app).post("/api/webhooks/twilio/sms-inbound").type("form").send({ From: "+14035550123", To: "+18666318939", Body: "hi", MessageSid: "SM-ks-1" });
  return callsMatching(h.query, /INSERT INTO communications_messages/)[0]![1] as unknown[];
}

beforeEach(() => {
  h.query.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("inbound SMS and Keystone contacts", () => {
  it("a sender who is only a Keystone contact is logged on the Keystone contact", async () => {
    const params = await inbound([[/WHERE silo = 'KS'/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "4035550123" ? [{ id: KS_CONTACT }] : [] })]]);
    expect(params[1]).toBe(KS_CONTACT);
    expect(params[7]).toBe("KS");
    expect(callsMatching(h.query, /INSERT INTO contacts/)).toHaveLength(0);
  });

  it("a BF contact still wins", async () => {
    const params = await inbound([
      [/WITH matched AS/, { rows: [{ id: BF_CONTACT }] }],
      [/WHERE silo = 'KS'/, { rows: [{ id: KS_CONTACT }] }],
    ]);
    expect(params[1]).toBe(BF_CONTACT);
    expect(params[7]).toBe("BF");
  });

  it("an unknown sender still becomes a BF contact", async () => {
    const params = await inbound([[/INSERT INTO contacts/, { rows: [{ id: BF_CONTACT }] }]]);
    expect(params[1]).toBe(BF_CONTACT);
    expect(params[7]).toBe("BF");
  });
});

describe("Outlook Sent Items and Keystone contacts", () => {
  it("logs the email on a Keystone contact in the KS silo, next to the BF match", async () => {
    const { logSentMessage } = await import("../../modules/o365/sentItemsLog.js");
    const q = vi.fn(answerBySql([
      [/FROM users/, { rows: [{ silo: "BF" }] }],
      [/FROM contacts/, { rows: [{ id: BF_CONTACT, silo: "BF" }, { id: KS_CONTACT, silo: "KS" }] }],
      [/INSERT INTO crm_email_log/, { rows: [], rowCount: 1 }],
    ]));
    const n = await logSentMessage({ query: q } as any, "user-1", {
      id: "AAMk-ks-1", subject: "Your Keystone demo", body: { content: "hi" },
      from: { emailAddress: { address: "todd@boreal.financial" } },
      toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
    } as any);
    expect(n).toBe(2);
    expect(String(callsMatching(q, /FROM contacts/)[0]![0])).toContain("(silo = $1 OR silo = 'KS')");
    const inserts = callsMatching(q, /INSERT INTO crm_email_log/).map((c) => c[1] as unknown[]);
    expect(inserts.map((p) => [p[7], p[8]])).toEqual([[BF_CONTACT, "BF"], [KS_CONTACT, "KS"]]);
  });
});
