// BF_SERVER_v821_DIALER - post-call AI summary for dialler calls: the GET /api/calls/:callSid/summary contract,
// its access rule, and the wiring that puts reception / direct-line / Watch-bridge / bare-To calls (plain <Dial>,
// never a conference) through the same recording -> transcript -> summary pipeline.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../modules/calls/calls.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/calls/calls.service.js")),
  startCall: async () => ({ id: "call-1" }),
}));

import { dialerCallSummary, nextStepsFrom, DIALER_SUMMARY_SQL } from "../services/calls/autoCallSummary.js";

const CALL_SID = "CA" + "1".repeat(32);
const LEG_SID = "CA" + "2".repeat(32);
const CONF = "c0f00000-0000-4000-8000-000000000001";
const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const OTHER_STAFF = "00000000-0000-4000-8000-0000000000b2";
const OWNER = "44444444-4444-4444-8444-444444444444";
const BRIDGE = "b0b0b0b0-0000-4000-8000-000000000009";
const CALLER = "+14035550142";
const SUMMARY_SQL = /AS viewer_on_call[\s\S]*FROM conferences cf/;

const NOW = new Date("2026-10-17T18:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

function summaryRow(row: Record<string, unknown>) {
  return {
    conference_id: CONF, contact_id: CONTACT, contact_name: "Jane Client", created_by_user_id: STAFF_USER_ID,
    call_status: "ended", created_at: minutesAgo(10), ended_at: minutesAgo(3), transcript_status: "completed",
    voice_intelligence_summary: null, suggested_tasks: null, recording_status: "completed", viewer_on_call: false, task_id: null,
    ...row,
  };
}
const q = (row: Record<string, unknown> | null) => async (_sql: string, _params: unknown[]) => ({ rows: row ? [summaryRow(row)] : [] });

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.ENABLE_CALL_RECORDING; });

describe("dialerCallSummary", () => {
  const me = { userId: STAFF_USER_ID, isAdmin: false };

  it("ready: summary, next steps from the extracted follow-ups, contact and the call's task", async () => {
    const r = await dialerCallSummary(CALL_SID, me, q({
      voice_intelligence_summary: "- Wants $250k LOC\nFollow-ups: send bank statements",
      suggested_tasks: [{ title: "Send bank statements", type: "EMAIL", dueInDays: 1 }, { title: "Call back Friday", type: "CALL", dueInDays: 3 }],
      task_id: "d0d0d0d0-0000-4000-8000-000000000003",
    }), NOW);
    expect(r).toEqual({ access: "ok", body: {
      status: "ready", summary: "- Wants $250k LOC\nFollow-ups: send bank statements",
      nextSteps: ["Send bank statements", "Call back Friday"],
      taskId: "d0d0d0d0-0000-4000-8000-000000000003", contactId: CONTACT, contactName: "Jane Client",
      // BF_SERVER_v831_DIALER_POLISH - the outcome sheet's suggested follow-ups
      suggestedTasks: [{ title: "Send bank statements", type: "EMAIL", dueInDays: 1 }, { title: "Call back Friday", type: "CALL", dueInDays: 3 }],
    } });
  });

  it("next steps fall back to the summary's Follow-ups line", () => {
    expect(nextStepsFrom("- a\n- b\nFollow-ups: send the void cheque; book a call Tuesday", [])).toEqual(["send the void cheque", "book a call Tuesday"]);
    expect(nextStepsFrom("- a\nFollow-ups: none", [])).toEqual([]);
    expect(nextStepsFrom("no follow up section", [])).toEqual([]);
  });

  it("pending while the recording / transcript is in flight", async () => {
    expect((await dialerCallSummary(CALL_SID, me, q({ transcript_status: "in-progress" }), NOW)).body).toEqual({
      status: "pending", contactId: CONTACT, contactName: "Jane Client",
    });
    expect((await dialerCallSummary(CALL_SID, me, q({ transcript_status: null, recording_status: "in-progress", call_status: "answered", ended_at: null, created_at: minutesAgo(5) }), NOW)).body.status).toBe("pending");
  });

  it("none: transcription failed, nothing recorded, or no summary long after the call", async () => {
    expect((await dialerCallSummary(CALL_SID, me, q({ transcript_status: "failed" }), NOW)).body.status).toBe("none");
    expect((await dialerCallSummary(CALL_SID, me, q({ recording_status: "absent", transcript_status: null }), NOW)).body.status).toBe("none");
    expect((await dialerCallSummary(CALL_SID, me, q({ recording_status: null, transcript_status: null, ended_at: minutesAgo(5) }), NOW)).body.status).toBe("none");
    expect((await dialerCallSummary(CALL_SID, me, q({ transcript_status: "in-progress", ended_at: minutesAgo(45) }), NOW)).body.status).toBe("none");
  });

  it("an unknown call is none and discloses nothing", async () => {
    expect(await dialerCallSummary(CALL_SID, me, q(null), NOW)).toEqual({ access: "ok", body: { status: "none" } });
  });

  it("staff read only calls they are on; Admin reads any", async () => {
    const notMine = { created_by_user_id: OTHER_STAFF, viewer_on_call: false, voice_intelligence_summary: "secret" };
    expect((await dialerCallSummary(CALL_SID, me, q(notMine), NOW)).access).toBe("forbidden");
    expect((await dialerCallSummary(CALL_SID, me, q({ ...notMine, viewer_on_call: true }), NOW)).body.status).toBe("ready");
    expect((await dialerCallSummary(CALL_SID, { userId: STAFF_USER_ID, isAdmin: true }, q(notMine), NOW)).body.summary).toBe("secret");
  });

  it("resolves any leg the app holds, or a Watch bridge id, and checks the viewer as a staff participant", () => {
    const sql = DIALER_SUMMARY_SQL;
    expect(sql).toContain("p.twilio_call_sid = $1");
    expect(sql).toContain("cf.friendly_name = 'wb_' || $1");
    expect(sql).toMatch(/vp\.kind = 'staff' AND vp\.identity = \$2/);
  });
});

describe("GET /api/calls/:callSid/summary", () => {
  const app = async () => mountRouter((await import("../routes/calls.js")).default, "/api/calls");

  it("returns the contract body", async () => {
    h.query.mockImplementation(answerBySql([[SUMMARY_SQL, { rows: [summaryRow({ created_by_user_id: STAFF_USER_ID, voice_intelligence_summary: "Summary text", suggested_tasks: [] })] }]]));
    const res = await request(await app()).get(`/api/calls/${CALL_SID}/summary`).set("Authorization", `Bearer ${staffToken("Staff")}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", summary: "Summary text", nextSteps: [], contactId: CONTACT, contactName: "Jane Client" });
    expect(callsMatching(h.query, SUMMARY_SQL)[0]![1]).toEqual([CALL_SID, STAFF_USER_ID]);
  });

  it("accepts a Watch bridge id", async () => {
    const res = await request(await app()).get(`/api/calls/${BRIDGE}/summary`).set("Authorization", `Bearer ${staffToken("Staff")}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "none" });
  });

  it("403 for a call the staff member was not on, 400 for a bad id, 401 without a sign-in", async () => {
    h.query.mockImplementation(answerBySql([[SUMMARY_SQL, { rows: [summaryRow({ created_by_user_id: OTHER_STAFF })] }]]));
    expect((await request(await app()).get(`/api/calls/${CALL_SID}/summary`).set("Authorization", `Bearer ${staffToken("Staff")}`)).status).toBe(403);
    expect((await request(await app()).get(`/api/calls/${CALL_SID}/summary`).set("Authorization", `Bearer ${staffToken("Admin")}`)).status).toBe(200);
    expect((await request(await app()).get(`/api/calls/not-a-sid/summary`).set("Authorization", `Bearer ${staffToken("Staff")}`)).status).toBe(400);
    expect((await request(await app()).get(`/api/calls/${CALL_SID}/summary`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const OPEN_RECORD = /INSERT INTO conferences \(friendly_name, silo, created_by_user_id, contact_id, direction, status, started_at\)/;
const PARTICIPANT = /INSERT INTO conference_participants \(conference_id, identity, phone_number, kind, role, status, twilio_call_sid\)/;
const recordOpened = { rows: [{ id: CONF, created: true }] };

describe("reception and direct-line calls answered in the app are recorded into the summary pipeline", () => {
  async function postWebhook(router: string, mount: string, path: string, body: Record<string, string>) {
    const app = mountRouter((await import(router)).default, mount);
    const res = await request(app).post(`${mount}${path}`).type("form").send(body);
    expect(res.status).toBe(200);
    return res.text;
  }

  it("direct line: notice to the caller, dual-channel recording filed under rx_<CallSid>, leg status on the <Client>", async () => {
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      [OPEN_RECORD, recordOpened],
    ]));
    const xml = await postWebhook("../routes/webhooks.js", "/api/webhooks", "/twilio/voice/twiml", { From: CALLER, To: "+18255550190", CallSid: CALL_SID });
    expect(xml).toContain("This call may be recorded for quality and training purposes.");
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toMatch(new RegExp(`recordingStatusCallback="[^"]*/api/webhooks/twilio/recording/status\\?conf=rx_${CALL_SID}"`));
    expect(xml).toMatch(new RegExp(`<Client statusCallback="[^"]*/api/webhooks/twilio/reception/leg-status\\?conf=rx_${CALL_SID}&amp;identity=${OWNER}"`));
    expect(xml).toContain('statusCallbackEvent="answered completed"');
    const [, params] = callsMatching(h.query, OPEN_RECORD)[0]!;
    expect(params).toEqual([`rx_${CALL_SID}`, "BF", null, null, "inbound"]);
    expect(callsMatching(h.query, PARTICIPANT)[0]![1]).toEqual([CONF, null, CALLER, "pstn", CALL_SID]);
  });

  it("ENABLE_CALL_RECORDING=false: no call record, no notice, the plain v820 ring", async () => {
    process.env.ENABLE_CALL_RECORDING = "false";
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      [OPEN_RECORD, recordOpened],
    ]));
    const xml = await postWebhook("../routes/webhooks.js", "/api/webhooks", "/twilio/voice/twiml", { From: CALLER, To: "+18255550190", CallSid: CALL_SID });
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("may be recorded");
    expect(xml).toMatch(new RegExp(`<Client[^>]*>${OWNER}</Client>`));
    expect(callsMatching(h.query, OPEN_RECORD)).toHaveLength(0);
  });

  it("reception named target: the <Dial> to the app records under rx_<CallSid>", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, { rows: [{
        status: "available", twilio_identity: OWNER, on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false, user_id: OWNER,
      }] }],
      [OPEN_RECORD, recordOpened],
    ]));
    const xml = await postWebhook("../routes/reception.js", "/api/webhooks/twilio/reception", "/intent?company=BF", { Digits: "2", From: CALLER, CallSid: CALL_SID });
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain(`conf=rx_${CALL_SID}`);
    expect(xml).toContain(`identity=${OWNER}`);
  });

  it("leg-status: the answering staff member joins the call record under their own leg's CallSid; completed ends it", async () => {
    h.query.mockImplementation(answerBySql([[/SELECT 1 FROM conference_participants WHERE twilio_call_sid = \$1/, { rows: [{ "?column?": 1 }] }]]));
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const path = `/api/webhooks/twilio/reception/leg-status?conf=rx_${CALL_SID}&identity=${OWNER}`;
    expect((await request(app).post(path).type("form").send({ CallSid: LEG_SID, ParentCallSid: CALL_SID, CallStatus: "in-progress" })).status).toBe(204);
    const [insertSql, insertParams] = callsMatching(h.query, /INSERT INTO conference_participants \(conference_id, identity, kind, role, status, twilio_call_sid, joined_at\)/)[0]!;
    expect(insertParams).toEqual([`rx_${CALL_SID}`, OWNER, LEG_SID]);
    expect(sqlText(insertSql)).toContain("'answered'"); // never 'joined': presence on_call is conference-only
    await request(app).post(path).type("form").send({ CallSid: LEG_SID, CallStatus: "completed" });
    expect(callsMatching(h.query, /UPDATE conferences SET status = 'ended'/)[0]![1]).toEqual([`rx_${CALL_SID}`]);
  });

  it("recording-notice tells the called party before they are connected", async () => {
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const res = await request(app).post("/api/webhooks/twilio/reception/recording-notice").type("form").send({});
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say></Response>');
  });

  it("a staff app call with a bare To records too (ob_<CallSid>), the callee hears the notice on answer", async () => {
    h.query.mockImplementation(answerBySql([[OPEN_RECORD, recordOpened]]));
    const xml = await postWebhook("../routes/webhooks.js", "/api/webhooks", "/twilio/voice/twiml", { From: `client:${STAFF_USER_ID}`, To: "+14035550177", CallSid: CALL_SID });
    expect(xml).toContain(`conf=ob_${CALL_SID}`);
    expect(xml).toMatch(/<Number url="[^"]*\/api\/webhooks\/twilio\/reception\/recording-notice" method="POST">\+14035550177<\/Number>/);
    const [, params] = callsMatching(h.query, OPEN_RECORD)[0]!;
    expect(params).toEqual([`ob_${CALL_SID}`, "BF", STAFF_USER_ID, null, "outbound"]);
    expect(callsMatching(h.query, PARTICIPANT).map((c) => (c[1] as unknown[]).slice(1))).toEqual([
      [STAFF_USER_ID, null, "staff", CALL_SID], [null, "+14035550177", "pstn", null],
    ]);
  });
});

describe("Watch callback bridges are recorded", () => {
  it("accept=1 opens wb_<bridge id> with the staff cell leg, records, and the client hears the notice", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT destination FROM watch_call_bridges/, { rows: [{ destination: "+14035550177" }] }],
      [/SELECT staff_user_id::text AS staff_user_id, contact_id::text AS contact_id, line FROM watch_call_bridges/, { rows: [{ staff_user_id: STAFF_USER_ID, contact_id: CONTACT, line: "BF" }] }],
      [OPEN_RECORD, recordOpened],
    ]));
    const app = mountRouter((await import("../watch/callRoutes.js")).default, "/api/telephony/watch");
    const res = await request(app).post(`/api/telephony/watch/provider/${BRIDGE}/accept`).type("form").send({ Digits: "1", CallSid: LEG_SID });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`conf=wb_${BRIDGE}`);
    expect(res.text).toContain('record="record-from-answer-dual"');
    expect(res.text).toMatch(/recording-notice" method="POST">\+14035550177<\/Number>/);
    expect(callsMatching(h.query, OPEN_RECORD)[0]![1]).toEqual([`wb_${BRIDGE}`, "BF", STAFF_USER_ID, CONTACT, "outbound"]);
    expect((callsMatching(h.query, PARTICIPANT)[0]![1] as unknown[]).slice(1)).toEqual([STAFF_USER_ID, null, "staff", LEG_SID]);
  });

  it("the bridge ending closes its call record", async () => {
    const app = mountRouter((await import("../watch/callRoutes.js")).default, "/api/telephony/watch");
    await request(app).post(`/api/telephony/watch/provider/${BRIDGE}/status`).type("form").send({ CallStatus: "completed" });
    expect(callsMatching(h.query, /UPDATE conferences SET status = 'ended'/)[0]![1]).toEqual([`wb_${BRIDGE}`]);
  });
});
