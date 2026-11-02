// BF_SERVER_v869_SETTINGS_PACK_BLOCKED_NUMBERS - blocked callers get a polite message or voicemail; their texts are ignored and
// logged. Database fake answers by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

import { normalizeNumber } from "../blockedNumbers.js";

const SPAM = "+14035550199";
const ADMIN = "11111111-1111-4111-8111-111111111111";
let callAction: "reject" | "voicemail";
let audits: unknown[];
function fake() {
  h.query.mockImplementation(answerBySql([
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === ADMIN ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/SELECT number FROM blocked_numbers/, { rows: [{ number: SPAM }] }],
    [/FROM boreal_settings WHERE key = \$1/, () => ({ rows: [{ value: { call_action: callAction } }] })],
    [/INSERT INTO blocked_numbers/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === SPAM ? [] : [{ id: "b1", number: p?.[0], reason: p?.[1] }] })],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push(p?.[4]); return { rows: [] }; }],
  ]));
}
async function signed(mount: string, loader: () => Promise<any>, path: string, params: Record<string, string>) {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use(mount, (await loader()).default);
  const full = mount + path;
  return request(a).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
}

beforeEach(async () => {
  h.query.mockReset(); callAction = "reject"; audits = [];
  (await import("../blockedNumbers.js")).clearBlockedCache();
  fake();
});

describe("blocked numbers", () => {
  it("normalises numbers as people type them", () => {
    expect(normalizeNumber("(403) 555-0199")).toBe(SPAM);
    expect(normalizeNumber("1-403-555-0199")).toBe(SPAM);
    expect(normalizeNumber("+44 20 7946 0000")).toBe("+442079460000");
    expect(normalizeNumber("call me")).toBeNull();
    expect(normalizeNumber("12345")).toBeNull();
  });

  it("a blocked caller hears a polite message and is hung up on; nobody is rung and the call is logged", async () => {
    const res = await signed("/api/webhooks", () => import("../../routes/webhooks.js"), "/twilio/voice/twiml", { From: SPAM, To: "+18255550100", CallSid: "CA-spam" });
    expect(res.text).toContain("Sorry, we're unable to take your call. Goodbye.");
    expect(res.text).toContain("<Hangup/>");
    expect(res.text).not.toContain("<Dial");
    expect(callsMatching(h.query, /INSERT INTO blocked_number_events/)[0]![1]).toEqual([SPAM, "call", "reject", null, "CA-spam"]);
    expect(callsMatching(h.query, /INSERT INTO call_logs|startCall/)).toHaveLength(0);
  });

  it("or goes straight to voicemail when the Admin chose that", async () => {
    callAction = "voicemail";
    const res = await signed("/api/webhooks/twilio/reception", () => import("../../routes/reception.js"), "/greeting", { From: SPAM, CallSid: "CA-spam2" });
    expect(res.text).toContain("<Record");
    expect(res.text).not.toContain("<Gather");
  });

  it("a text from a blocked number is ignored and logged; a STOP is still honoured", async () => {
    const res = await signed("/api", () => import("../../routes/smsInboundWebhook.js"), "/webhooks/twilio/sms-inbound", { From: SPAM, To: "+18255550100", Body: "cheap loans!!!", MessageSid: "SM1" });
    expect(res.text).toBe("<Response/>");
    expect(callsMatching(h.query, /INSERT INTO communications_messages|INSERT INTO communications_conversations/)).toHaveLength(0);
    expect(callsMatching(h.query, /INSERT INTO blocked_number_events/)[0]![1]).toEqual([SPAM, "text", "ignored", "cheap loans!!!", "SM1"]);
    await signed("/api", () => import("../../routes/smsInboundWebhook.js"), "/webhooks/twilio/sms-inbound", { From: SPAM, To: "+18255550100", Body: "STOP", MessageSid: "SM2" });
    expect(callsMatching(h.query, /UPDATE contacts SET sms_opt_out = \$2/)).toHaveLength(1);
  });

  it("an unblocked caller is untouched", async () => {
    const { isBlocked } = await import("../blockedNumbers.js");
    expect(await isBlocked({ query: h.query } as any, "+14035550100")).toBe(false);
  });

  it("Admins block, unblock and choose what callers hear (audited)", async () => {
    const tok = jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    const a = express();
    a.use(express.json());
    a.use("/api/blocked-numbers", (await import("../../routes/blockedNumbers.js")).default);
    expect((await request(a).post("/api/blocked-numbers").set("Authorization", `Bearer ${tok}`).send({ number: "hello" })).status).toBe(400);
    expect((await request(a).post("/api/blocked-numbers").set("Authorization", `Bearer ${tok}`).send({ number: "(403) 555-0199" })).status).toBe(409);
    const ok = await request(a).post("/api/blocked-numbers").set("Authorization", `Bearer ${tok}`).send({ number: "403 555 0123", reason: "Robocaller" });
    expect(ok.status).toBe(201);
    expect(ok.body.number.number).toBe("+14035550123");
    const s = await request(a).put("/api/blocked-numbers/settings").set("Authorization", `Bearer ${tok}`).send({ call_action: "voicemail" });
    expect(s.body.settings).toEqual({ call_action: "voicemail" });
    expect(audits).toEqual(expect.arrayContaining(["blocked_number.added", "blocked_number.settings_updated"]));
  });
});
