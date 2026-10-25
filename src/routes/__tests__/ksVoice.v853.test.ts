// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone phone line end to end at the TwiML level: Twilio-signed requests,
// the menu, ringing the queue's Keystone staff with the caller card, closed hours and no-answer to voicemail, support
// calls and voicemails onto a ticket, and the general voice URL handing the Keystone number over. Database faked by
// SQL content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  startCall: vi.fn(async () => ({ id: "call-log-1" })),
  enrich: vi.fn(async () => undefined),
  notify: vi.fn(async () => ({ smsSent: 0, notifsCreated: 1, recipientCount: 1 })),
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../modules/calls/calls.service.js", async (orig) => ({ ...(await orig<any>()), startCall: h.startCall }));
vi.mock("../../modules/voice/voicemailEnrich.service.js", () => ({ enrichAndDistributeVoicemail: h.enrich }));
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notify }));

const KS_NUMBER = "+15878750815";
const CALLER = "+14035550123";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";
const STAFF_A = "44444444-4444-4444-8444-444444444444";
const CALL_SID = "CA" + "a".repeat(32);

async function signedPost(mount: string, modPath: string, path: string, params: Record<string, string>, token = String(process.env.TWILIO_AUTH_TOKEN)) {
  const router = (await import(modPath)).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mount, router);
  const full = mount + path;
  return request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(token, "https://example.com" + full, params))
    .send(params);
}
const ks = (path: string, params: Record<string, string>) => signedPost("/api/webhooks/twilio/ks", "../ksVoice.js", path, params);
const flush = () => new Promise((r) => setTimeout(r, 30));

// An open, always-on queue by default; the test's own rules win.
const ALWAYS_OPEN = { queue: "support", label: "Support", ring_user_ids: [], ring_timeout_seconds: 20, hours_enabled: false, timezone: "America/Regina", weekly: {}, updated_at: null };
function db(rules: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...rules,
    [/FROM ks_phone_queues/, { rows: [ALWAYS_OPEN] }],
    [/FROM contacts c\s+WHERE c\.silo = 'KS'/, { rows: [{ contact_id: CONTACT, contact_name: "Ada Lovelace", company_id: COMPANY, company_name: "Acme Lending", ks_support_level: "premium", ks_stage: "paying" }] }],
    [/FROM users u JOIN staff_presence sp/, { rows: [{ user_id: STAFF_A, twilio_identity: "ks-agent-a" }] }],
    [/INSERT INTO conferences/, { rows: [{ id: "55555555-5555-4555-8555-555555555555", created: true }] }],
    [/INSERT INTO ks_support_tickets/, { rows: [{ id: TICKET, number: 1001 }] }],
    [/INSERT INTO ks_support_ticket_messages/, { rows: [{ id: "66666666-6666-4666-8666-666666666666" }] }],
    [/FROM users u WHERE \(coalesce\(u\.active/, { rows: [{ id: STAFF_A }] }],
  ]));
}

beforeEach(() => {
  h.query.mockReset();
  h.startCall.mockClear();
  h.enrich.mockClear();
  h.notify.mockClear();
  process.env.KS_VOICE_NUMBER = KS_NUMBER;
  db();
});
afterEach(() => {
  delete process.env.KS_VOICE_NUMBER;
});

describe("Keystone line: greeting and menu", () => {
  it("refuses an unsigned request", async () => {
    const res = await signedPost("/api/webhooks/twilio/ks", "../ksVoice.js", "/voice", { CallSid: CALL_SID, From: CALLER }, "wrong-token");
    expect(res.status).toBe(403);
  });

  it("is a polite 'not in service' while KS_VOICE_NUMBER is unset", async () => {
    delete process.env.KS_VOICE_NUMBER;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await ks("/voice", { CallSid: CALL_SID, From: CALLER, To: KS_NUMBER });
    expect(res.text).toContain("not in service");
    expect(res.text).toContain("<Hangup/>");
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("greets the caller with the Keystone menu and logs the call in silo KS against the matched contact", async () => {
    const res = await ks("/voice", { CallSid: CALL_SID, From: CALLER, To: KS_NUMBER });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Thanks for calling Keystone. This call may be recorded. Press 1 for sales, 2 for support.");
    expect(res.text).toContain('action="/api/webhooks/twilio/ks/menu"');
    expect(h.startCall).toHaveBeenCalledWith(expect.objectContaining({ direction: "inbound", silo: "KS", crmContactId: CONTACT, twilioCallSid: CALL_SID }));
  });

  it("asks once more when nothing was chosen, then goes to sales", async () => {
    const first = await ks("/menu?retry=0", { CallSid: CALL_SID, From: CALLER });
    expect(first.text).toContain("Sorry, I didn't catch that.");
    expect(first.text).toContain("/api/webhooks/twilio/ks/menu?retry=1");
    const second = await ks("/menu?retry=1", { CallSid: CALL_SID, From: CALLER });
    expect(second.text).toContain("connecting you to Keystone sales");
  });
});

describe("Keystone line: ringing a queue", () => {
  it("2 rings the support group in the app / softphone with the caller card, recorded, and opens a support ticket", async () => {
    const res = await ks("/menu", { CallSid: CALL_SID, From: CALLER, Digits: "2" });
    expect(res.text).toContain("One moment, connecting you to Keystone support.");
    expect(res.text).toContain("<Identity>ks-agent-a</Identity>");
    expect(res.text).toContain('<Parameter name="callerName" value="Ada Lovelace"/>');
    expect(res.text).toContain('<Parameter name="callerCompany" value="Acme Lending"/>');
    expect(res.text).toContain('<Parameter name="callerStage" value="Keystone support line"/>');
    expect(res.text).toContain('action="/api/webhooks/twilio/ks/no-answer?queue=support"');
    expect(res.text).toContain('timeout="20"');
    expect(res.text).toContain(`callerId="${CALLER}"`);
    expect(res.text).toContain('record="record-from-answer-dual"');
    // The call record is filed under silo KS with the contact, so the AI summary lands on their KS timeline.
    const [, confParams] = callsMatching(h.query, /INSERT INTO conferences/)[0]!;
    expect(confParams).toEqual([`rx_${CALL_SID}`, "KS", null, CONTACT, "inbound"]);
    await flush();
    const [, ticketParams] = callsMatching(h.query, /INSERT INTO ks_support_tickets/)[0]!;
    expect((ticketParams as unknown[]).slice(0, 4)).toEqual([COMPANY, CONTACT, "Phone call from Ada Lovelace", "phone"]);
    expect((ticketParams as unknown[])[7]).toBe("premium");
    const [, msgParams] = callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]!;
    expect((msgParams as unknown[]).slice(1, 3)).toEqual(["call", "phone"]);
    expect((msgParams as unknown[])[6]).toBe(CALL_SID);
  });

  it("a support call from someone with an open ticket goes on that ticket", async () => {
    db([[/FROM ks_support_tickets\s+WHERE status IN/, { rows: [{ id: TICKET }] }]]);
    await ks("/menu", { CallSid: CALL_SID, From: CALLER, Digits: "2" });
    await flush();
    expect(callsMatching(h.query, /INSERT INTO ks_support_tickets/)).toHaveLength(0);
    expect(callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1]).toEqual(expect.arrayContaining([TICKET, "call"]));
  });

  it("1 rings sales and never opens a ticket", async () => {
    const res = await ks("/menu", { CallSid: CALL_SID, From: CALLER, Digits: "1" });
    expect(res.text).toContain("connecting you to Keystone sales");
    expect(res.text).toContain("no-answer?queue=sales");
    await flush();
    expect(callsMatching(h.query, /INSERT INTO ks_support_tickets/)).toHaveLength(0);
  });

  it("outside the queue's hours the caller goes straight to voicemail (still a support ticket)", async () => {
    db([[/FROM ks_phone_queues/, { rows: [{ ...ALWAYS_OPEN, hours_enabled: true, weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } }] }]]);
    const res = await ks("/menu", { CallSid: CALL_SID, From: CALLER, Digits: "2" });
    expect(res.text).toContain("Keystone support is closed right now.");
    expect(res.text).toContain('action="/api/webhooks/twilio/ks/voicemail?queue=support"');
    expect(res.text).not.toContain("<Dial");
    await flush();
    expect(callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1]).toEqual(expect.arrayContaining(["call", "Support line call from Ada Lovelace (+14035550123) (after hours)."]));
  });

  it("with nobody free: voicemail, and the queue's staff hear about the missed call", async () => {
    db([[/FROM users u JOIN staff_presence sp/, { rows: [] }]]);
    const res = await ks("/menu", { CallSid: CALL_SID, From: CALLER, Digits: "1" });
    expect(res.text).toContain("no one is available");
    expect(res.text).toContain("voicemail?queue=sales");
    await flush();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      silo: "KS", userIds: [STAFF_A], title: "Missed Keystone sales call",
      staffAlert: { category: "MISSED_CALL", type: "missed_call", data: { phone: CALLER } },
    }));
  });
});

describe("Keystone line: no answer and voicemail", () => {
  it("an unanswered ring goes to voicemail; an answered call just ends", async () => {
    const missed = await ks("/no-answer?queue=support", { CallSid: CALL_SID, From: CALLER, DialCallStatus: "no-answer" });
    expect(missed.text).toContain("no one was able to pick up");
    expect(missed.text).toContain("voicemail?queue=support");
    const done = await ks("/no-answer?queue=support", { CallSid: CALL_SID, From: CALLER, DialCallStatus: "completed" });
    expect(done.text).toContain("<Hangup/>");
    expect(done.text).not.toContain("<Record");
  });

  it("a support voicemail is saved in silo KS, transcribed by the shared pipeline and added to the call's ticket", async () => {
    db([
      [/FROM voicemails WHERE recording_sid/, { rows: [{ transcript: "My uploads are failing", contact_id: CONTACT, url: "https://blob/vm.mp3" }] }],
      [/SELECT ticket_id::text AS id FROM ks_support_ticket_messages WHERE call_sid = \$1 ORDER BY/, { rows: [{ id: TICKET }] }],
      [/UPDATE ks_support_tickets\s+SET last_message_at/, { rows: [{ number: 1001, subject: "Phone call", assignee_user_id: STAFF_A }] }],
    ]);
    const res = await ks("/voicemail?queue=support", { CallSid: CALL_SID, From: CALLER, RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingSid: "RE1", RecordingDuration: "12" });
    expect(res.text).toContain("Thank you. We will be in touch shortly.");
    const [sql, params] = callsMatching(h.query, /INSERT INTO voicemails/)[0]!;
    expect(String(sql)).toContain("'KS'");
    expect(params).toEqual([CALL_SID, "RE1", "https://api.twilio.com/rec/RE1", 12, CALLER]);
    await flush();
    expect(h.enrich).toHaveBeenCalledWith(expect.objectContaining({ callSid: CALL_SID, recordingSid: "RE1", staffUserId: null }));
    const vmMsg = callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1] as unknown[];
    expect(vmMsg.slice(0, 4)).toEqual([TICKET, "voicemail", "phone", "Voicemail: My uploads are failing"]);
    expect(vmMsg[7]).toBe("https://blob/vm.mp3");
    expect(callsMatching(h.query, /INSERT INTO ks_support_tickets/)).toHaveLength(0);
    // The assignee hears about it, and so does the support team.
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ userIds: [STAFF_A], title: "New voicemail on Keystone ticket #1001" }));
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: "Keystone support voicemail from Ada Lovelace", body: "My uploads are failing",
      staffAlert: { category: "VOICEMAIL", type: "voicemail", data: { contactId: CONTACT, phone: CALLER } },
    }));
  });

  it("keeps the matched licensee when enrichment creates an unlinked Unknown caller contact", async () => {
    let enriched = false;
    h.enrich.mockImplementationOnce(async () => { enriched = true; return undefined; });
    db([
      [/FROM contacts c\s+WHERE c\.silo = 'KS'/, () => ({ rows: enriched
        ? [{ contact_id: CONTACT, contact_name: "Unknown caller", company_id: null }]
        : [] })],
      [/FROM companies co\s+WHERE co\.silo = 'KS'/, { rows: [{ company_id: COMPANY, company_name: "Acme Lending", ks_support_level: "premium" }] }],
      [/FROM voicemails WHERE recording_sid/, { rows: [{ contact_id: CONTACT, transcript: "Please help" }] }],
    ]);
    const { afterKsVoicemail } = await import("../ksVoice.js");
    await afterKsVoicemail({ queue: "support", callSid: CALL_SID, recordingSid: "RE-new", recordingUrl: "https://example.com/vm", duration: 10, from: CALLER });
    expect(callsMatching(h.query, /UPDATE contacts SET company_id/)[0]![1]).toEqual([CONTACT, COMPANY]);
    const ticket = callsMatching(h.query, /INSERT INTO ks_support_tickets/)[0]![1] as unknown[];
    expect(ticket.slice(0, 2)).toEqual([COMPANY, CONTACT]);
    expect(ticket[7]).toBe("premium");
  });

  it("a sales voicemail is filed and alerted but makes no ticket", async () => {
    db([[/FROM voicemails WHERE recording_sid/, { rows: [{ transcript: "Interested in Pro", contact_id: CONTACT, url: null }] }]]);
    await ks("/voicemail?queue=sales", { CallSid: CALL_SID, From: CALLER, RecordingUrl: "https://api.twilio.com/rec/RE2", RecordingSid: "RE2" });
    await flush();
    expect(h.enrich).toHaveBeenCalled();
    expect(callsMatching(h.query, /ks_support_ticket/)).toHaveLength(0);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Keystone sales voicemail from Ada Lovelace" }));
  });
});

describe("the general voice URL", () => {
  it("hands a call to the Keystone number to the Keystone menu, without logging it as a BF call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await signedPost("/api/webhooks", "../webhooks.js", "/twilio/voice/twiml", { CallSid: CALL_SID, From: CALLER, To: KS_NUMBER });
    expect(res.text).toContain("<Redirect method=\"POST\">/api/webhooks/twilio/ks/voice</Redirect>");
    expect(h.startCall).not.toHaveBeenCalled();
  });

  it("leaves every other number alone (and the Keystone check is off when KS_VOICE_NUMBER is unset)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = await signedPost("/api/webhooks", "../webhooks.js", "/twilio/voice/twiml", { CallSid: CALL_SID, From: CALLER, To: "+18666318939" });
    expect(other.text).not.toContain("/twilio/ks/voice");
    delete process.env.KS_VOICE_NUMBER;
    const off = await signedPost("/api/webhooks", "../webhooks.js", "/twilio/voice/twiml", { CallSid: CALL_SID, From: CALLER, To: KS_NUMBER });
    expect(off.text).not.toContain("/twilio/ks/voice");
  });
});
