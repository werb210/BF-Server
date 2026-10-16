// BF_SERVER_v817_DIALER_MESSAGING - behaviour tests for the dialer / messaging audit fixes:
// SMS number normalisation + contact creation, mini-portal message contact, Maya handoff row,
// outbound caller ID / status callback, IVR ring eligibility + voice token registration, ?q= search.
import { createRequire } from "node:module";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), smsCreate: vi.fn(), callsCreate: vi.fn(), staffSms: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const q = (...a: unknown[]) => h.query(...a);
  return { ...actual, pool: { query: q }, dbQuery: q, runQuery: q };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedTwilio: () => ({ messages: { create: h.smsCreate } }),
  sharedOpenAI: () => ({}),
}));
vi.mock("../services/notifications/staffSms.js", () => ({ sendStaffNotification: h.staffSms }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../telephony/services/tokenService.js", async () => ({
  ...(await vi.importActual<any>("../telephony/services/tokenService.js")),
  generateVoiceToken: (identity: string) => `tok-${identity}`,
}));

// conferenceService loads twilio through createRequire, so the fake goes into the CJS cache.
const cjsRequire = createRequire(import.meta.url);
const twilioPath = cjsRequire.resolve("twilio");
const fakeTwilio = () => ({ calls: { create: h.callsCreate } });

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const staffJwt = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function commsApp() {
  const router = (await import("../routes/communications.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/communications", router);
  return a;
}

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  h.smsCreate.mockReset().mockResolvedValue({ sid: "SM817", status: "queued" });
  h.callsCreate.mockReset().mockResolvedValue({ sid: "CA817" });
  h.staffSms.mockReset().mockResolvedValue({ sent: 0 });
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000817";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
});
afterEach(() => {
  delete process.env.TWILIO_FROM_NUMBER;
});

describe("1. POST /api/communications/sms normalises the number and files it under a contact", () => {
  it("normalizeSmsTo / formatPhoneForName", async () => {
    const { normalizeSmsTo, formatPhoneForName } = await import("../routes/communications.js");
    expect(normalizeSmsTo("4035550142")).toEqual({ e164: "+14035550142" });
    expect(normalizeSmsTo("(403) 555-0142")).toEqual({ e164: "+14035550142" });
    expect(normalizeSmsTo("1-403-555-0142")).toEqual({ e164: "+14035550142" });
    expect(normalizeSmsTo("+447700900123")).toEqual({ e164: "+447700900123" });
    expect(normalizeSmsTo("555-0142")).toEqual({ error: "invalid_number" });
    expect(formatPhoneForName("+14035550142")).toBe("(403) 555-0142");
  });

  it("sends to E.164, creates a contact when none matches, and stores the thread under it", async () => {
    const NEW = "11111111-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([[/INSERT INTO contacts/, { rows: [{ id: NEW }] }]]));
    const res = await request(await commsApp()).post("/api/communications/sms")
      .set("Authorization", `Bearer ${staffJwt()}`).send({ to: "(587) 444-1234", body: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(NEW);
    expect(h.smsCreate.mock.calls[0][0].to).toBe("+15874441234");
    const [ins] = callsMatching(h.query, /INSERT INTO contacts/);
    const p = ins[1] as unknown[];
    expect(p[1]).toBe("(587) 444-1234"); // name
    expect(p[5]).toBe("+15874441234"); // phone
    expect(p[14]).toBe("other"); // role, as inbound SMS creates it
    expect(p[17]).toBe("BF"); // silo
    const [msg] = callsMatching(h.query, /INSERT INTO communications_messages/);
    expect(msg[1]).toEqual(expect.arrayContaining(["+15874441234", NEW]));
    const [del] = callsMatching(h.query, /INSERT INTO sms_deliveries/);
    expect((del[1] as unknown[])[1]).toBe("+15874441234");
  });

  it("uses the existing contact when one matches and creates none", async () => {
    const CID = "22222222-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([[/FROM contacts c\s+WHERE right\(regexp_replace/, { rows: [{ id: CID }] }]]));
    const res = await request(await commsApp()).post("/api/communications/sms")
      .set("Authorization", `Bearer ${staffJwt()}`).send({ to: "5874441234", body: "hi" });
    expect(res.body.contactId).toBe(CID);
    expect(callsMatching(h.query, /INSERT INTO contacts/)).toHaveLength(0);
  });

  it("refuses a number without an area code", async () => {
    const res = await request(await commsApp()).post("/api/communications/sms")
      .set("Authorization", `Bearer ${staffJwt()}`).send({ to: "555-0142", body: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "invalid_number", message: "Enter a full phone number with area code." });
    expect(h.smsCreate).not.toHaveBeenCalled();
  });
});

describe("2. mini-portal message gets a contact", () => {
  async function clientApp() {
    const router = (await import("../routes/client/index.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/client", router);
    return a;
  }
  const APP_ID = "app-mini-portal-817";

  it("falls back to application_contacts and links it to the application", async () => {
    const CID = "33333333-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([
      [/SELECT contact_id, silo, metadata/, { rows: [{ contact_id: null, silo: "BF", metadata: {}, business_legal_name: null, name: null }] }],
      [/FROM application_contacts/, { rows: [{ contact_id: CID }] }],
    ]));
    const r = await request(await clientApp()).post("/api/client/messages").send({ applicationId: APP_ID, body: "hi" });
    expect(r.status).toBe(201);
    const [link] = callsMatching(h.query, /UPDATE applications SET contact_id = \$2::uuid/);
    expect(link[1]).toEqual([APP_ID, CID]);
    const [msg] = callsMatching(h.query, /INSERT INTO communications_messages/);
    expect((msg[1] as unknown[])[4]).toBe(CID);
    expect(callsMatching(h.query, /INSERT INTO contacts/)).toHaveLength(0);
  });

  it("creates a contact from the client's phone and the applicant name in metadata", async () => {
    const NEW = "44444444-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([
      [/SELECT contact_id, silo, metadata/, { rows: [{ contact_id: null, silo: "BI", metadata: { applicant: { firstName: "Dana", lastName: "Reyes" } }, business_legal_name: "Reyes Ltd", name: null }] }],
      [/INSERT INTO contacts/, { rows: [{ id: NEW }] }],
    ]));
    const token = jwt.sign({ sub: "client:+14035550142", role: "client", phone: "+1 (403) 555-0142" }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
    const r = await request(await clientApp()).post("/api/client/messages").set("Authorization", "Bearer " + token).send({ applicationId: APP_ID, body: "hi" });
    expect(r.status).toBe(201);
    const p = callsMatching(h.query, /INSERT INTO contacts/)[0][1] as unknown[];
    expect(p[1]).toBe("Dana Reyes");
    expect(p[5]).toBe("+14035550142");
    expect(p[17]).toBe("BI");
    expect((callsMatching(h.query, /INSERT INTO communications_messages/)[0][1] as unknown[])[4]).toBe(NEW);
  });

  it("an application that already has a contact is left alone", async () => {
    const CID = "55555555-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([[/SELECT contact_id, silo, metadata/, { rows: [{ contact_id: CID, silo: "BF", metadata: {} }] }]]));
    await request(await clientApp()).post("/api/client/messages").send({ applicationId: APP_ID, body: "hi" });
    expect(callsMatching(h.query, /FROM application_contacts/)).toHaveLength(0);
    expect((callsMatching(h.query, /INSERT INTO communications_messages/)[0][1] as unknown[])[4]).toBe(CID);
  });
});

describe("3. Maya handoff writes a Messages row only for a known contact", () => {
  it("known contact -> one inbound 'message' row", async () => {
    const CID = "66666666-0000-4000-8000-000000000817";
    h.query.mockImplementation(answerBySql([
      [/SELECT id FROM contacts/, { rows: [{ id: CID }] }],
      [/SELECT id FROM applications WHERE contact_id/, { rows: [{ id: "app-1" }] }],
    ]));
    const res = await request(await commsApp()).post("/api/communications/maya-handoff")
      .set("Authorization", `Bearer ${staffJwt()}`)
      .send({ recipients: "available", summary: "Wants a call about rates", phone: "403-555-0142", silo: "BF" });
    expect(res.status).toBe(200);
    const rows = callsMatching(h.query, /INSERT INTO communications_messages/);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toMatch(/'message', 'inbound', 'received'/);
    expect(rows[0][1]).toEqual([CID, "app-1", "BF", "Asked to talk to a person: Wants a call about rates"]);
  });

  it("anonymous visitor -> no Messages row (v763)", async () => {
    const res = await request(await commsApp()).post("/api/communications/maya-handoff")
      .set("Authorization", `Bearer ${staffJwt()}`).send({ recipients: "available" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO communications_messages/)).toHaveLength(0);
    expect(callsMatching(h.query, /INSERT INTO maya_escalations/)).toHaveLength(1);
  });
});

describe("4. outbound call caller ID and status callback", () => {
  let saved: any;
  beforeEach(() => {
    saved = cjsRequire.cache[twilioPath];
    cjsRequire.cache[twilioPath] = { id: twilioPath, filename: twilioPath, loaded: true, exports: fakeTwilio } as any;
    vi.resetModules();
    delete process.env.TWILIO_CALLER_ID;
    delete process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID;
    delete process.env.TWILIO_PHONE_NUMBER;
  });
  afterEach(() => { if (saved) cjsRequire.cache[twilioPath] = saved; else delete cjsRequire.cache[twilioPath]; });

  it("PSTN leg shows the resolved caller ID and reports to /api/webhooks/twilio/call/status", async () => {
    const svc = await import("../voice/conferenceService.js");
    await svc.dialPstnIntoConference({ conferenceFriendly: "conf-1", toNumber: "+14035550142", fromNumber: "+18254511768", participantId: "p1" });
    const args = h.callsCreate.mock.calls[0][0];
    expect(args.from).toBe("+18254511768");
    expect(args.statusCallback).toMatch(/\/api\/webhooks\/twilio\/call\/status$/);
  });

  it("falls back to the configured caller ID, then the 866 main line", async () => {
    const svc = await import("../voice/conferenceService.js");
    delete process.env.TWILIO_FROM_NUMBER;
    expect(svc.__outboundFrom("")).toBe("+18666318939");
    process.env.TWILIO_CALLER_ID = "+15875550199";
    expect(svc.__outboundFrom(undefined)).toBe("+15875550199");
    await svc.dialClientIntoConference({ conferenceFriendly: "conf-1", identity: "staff-1", participantId: "p2" });
    expect(h.callsCreate.mock.calls[0][0].from).toBe("+15875550199");
    expect(h.callsCreate.mock.calls[0][0].statusCallback).toMatch(/\/api\/webhooks\/twilio\/call\/status$/);
  });
});

describe("5. incoming calls ring a registered dialler with a stale heartbeat", () => {
  it("POST /api/voice/token registers the client identity in staff_presence", async () => {
    const router = (await import("../routes/voiceCalls.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/voice", router);
    const res = await request(a).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe(STAFF_ID);
    const [up] = callsMatching(h.query, /INSERT INTO staff_presence/);
    expect(up[0]).toMatch(/voice_token_at/);
    expect(up[0]).toMatch(/ON CONFLICT \(user_id\) DO UPDATE SET twilio_identity/);
    expect(up[1]).toEqual([STAFF_ID, STAFF_ID]);
  });

  it("the engagement group ring includes ringable (not just 'available') staff", async () => {
    vi.doMock("../middleware/twilioWebhookValidation.js", () => {
      const pass = (_req: unknown, _res: unknown, next: () => void) => next();
      return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
    });
    h.query.mockImplementation(answerBySql([
      [/SELECT DISTINCT sp\.twilio_identity/, (sql: string) => ({ rows: /voice_token_at/.test(sql) && !/WHERE sp\.status = 'available'/.test(sql) ? [{ twilio_identity: "closed-ios-app" }] : [] })],
    ]));
    const router = (await import("../routes/reception.js")).default;
    const a = express();
    a.use(express.urlencoded({ extended: false }));
    a.use("/api/webhooks/twilio/reception", router);
    const res = await request(a).post("/api/webhooks/twilio/reception/intent").type("form").send({ Digits: "1", From: "+14035550142" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Client>closed-ios-app</Client>");
    vi.doUnmock("../middleware/twilioWebhookValidation.js");
  });

  it("ringableStaffSql keeps manual busy / on call / meeting out and uses Alberta (UTC-6) hours", async () => {
    const { ringableStaffSql } = await import("../modules/presence/presenceService.js");
    const sql = ringableStaffSql("sp", "u");
    expect(sql).toMatch(/coalesce\(sp\.manual_busy, false\) = false/);
    expect(sql).toMatch(/coalesce\(sp\.on_call, false\) = false/);
    expect(sql).toMatch(/coalesce\(sp\.in_meeting, false\) = false/);
    // Alberta is UTC-6 all year (src/lib/albertaTime.ts); America/Edmonton would be an hour off in winter.
    expect(sql).toMatch(/America\/Regina/);
  });
});

describe("7. ?q= search on the thread lists", () => {
  it("threadSearchClause: name ILIKE + last-10-digit phone match; nothing without q", async () => {
    const { threadSearchClause } = await import("../routes/communications.js");
    expect(threadSearchClause(undefined, 2, ["c.name"], ["c.phone"])).toEqual({ sql: "", params: [] });
    const byName = threadSearchClause("dana", 2, ["c.name"], ["c.phone"]);
    expect(byName.params).toEqual(["%dana%"]);
    expect(byName.sql).toBe("AND (c.name ILIKE $2)");
    const byPhone = threadSearchClause("+1 (403) 555-0142", 3, ["c.name"], ["c.phone"]);
    expect(byPhone.params[1]).toBe("4035550142");
    expect(byPhone.sql).toMatch(/c\.name ILIKE \$3 OR right\(regexp_replace\(coalesce\(c\.phone, ''\), '\[\^0-9\]', '', 'g'\), 10\) LIKE '%' \|\| \$4 \|\| '%'/);
  });

  it("GET /sms binds q after the silo; without q the query is unchanged", async () => {
    const app = await commsApp();
    await request(app).get("/api/communications/sms?q=dana").set("Authorization", `Bearer ${staffJwt()}`);
    const [withQ] = callsMatching(h.query, /m\.type = 'sms'/);
    expect(withQ[1]).toEqual(["BF", "%dana%"]);
    expect(withQ[0]).toMatch(/c\.name ILIKE \$2/);
    h.query.mockClear();
    await request(app).get("/api/communications/sms").set("Authorization", `Bearer ${staffJwt()}`);
    const [noQ] = callsMatching(h.query, /m\.type = 'sms'/);
    expect(noQ[1]).toEqual(["BF"]);
    expect(noQ[0]).not.toMatch(/ILIKE/);
    // 6. inbound verification-code / short-code texts are kept out of the thread list
    expect(noQ[0]).toMatch(/m\.direction = 'inbound' AND/);
    expect(noQ[0]).toMatch(/verification/);
  });

  it("GET /messages-list binds q after the type filter", async () => {
    const app = await commsApp();
    await request(app).get("/api/communications/messages-list?types=message&q=4035550142").set("Authorization", `Bearer ${staffJwt()}`);
    const [call] = callsMatching(h.query, /m\.contact_id IS NOT NULL/);
    expect(call[1]).toEqual(["BF", ["message"], "%4035550142%", "4035550142"]);
    expect(call[0]).toMatch(/c\.name ILIKE \$3 OR c\.email ILIKE \$3 OR right/);
  });
});

// BF_SERVER_v817_DIALER_MESSAGING - call-events event_type normalisation (the dialler sent
// "call_completed", which broke call_events_event_type_check and 500'd).
import { normalizeCallEventType } from "../routes/communications.js";
describe("v817 normalizeCallEventType", () => {
  it("maps the dialler's legacy names onto the CHECK constraint values", () => {
    expect(normalizeCallEventType("call_completed")).toBe("call.ended");
    expect(normalizeCallEventType("call.ended")).toBe("call.ended");
    expect(normalizeCallEventType("call_failed")).toBe("call.failed");
    expect(normalizeCallEventType("missed")).toBe("call.missed");
    expect(normalizeCallEventType("CALL.DECLINED")).toBe("call.declined");
  });
  it("rejects anything else (400, not a constraint 500)", () => {
    expect(normalizeCallEventType("ringing")).toBe("");
    expect(normalizeCallEventType("")).toBe("");
    expect(normalizeCallEventType(undefined)).toBe("");
  });
});
