// BF_SERVER_v829_DIALER_RELIABILITY - the iPhone dialler audit, batch 1:
//   - inbound calls record who answered (call outcomes could never be saved: "APIError error 3")
//   - outbound: the customer is dialled when the staff leg joins (dialOnJoin), staff hear ringback, busy / no answer
//     ends the call with the reason, and every dialled leg's CallSid is saved
//   - no recording notice to staff legs; the dialler's own call events are stored
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { STAFF_USER_ID, bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  dialPstn: vi.fn(async () => ({ callSid: "CA-callee" })),
  dialPending: vi.fn(async () => 1),
  unanswered: vi.fn(async () => null as string | null),
}));
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  pool: { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) },
  runQuery: h.queryMock,
  dbQuery: h.queryMock,
}));
vi.mock("../voice/conferenceService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../voice/conferenceService.js")>()),
  createConference: vi.fn(async () => ({ id: "conf-1", friendly_name: "conf-friendly" })),
  addParticipantRow: vi.fn(async (args: any) => (args.status === "pending_dial" ? "pid-pending" : "pid-1")),
  dialPstnIntoConference: h.dialPstn,
  getConferenceByFriendly: vi.fn(async () => ({ id: "conf-1", friendly_name: "conf-friendly", direction: "outbound", twilio_conference_sid: null })),
  getParticipantBySid: vi.fn(async () => ({ id: "pid-callee", conference_id: "conf-1", kind: "pstn", role: "participant", status: "ringing", joined_at: null })),
  notifyConferenceState: vi.fn(async () => undefined),
}));
vi.mock("../modules/voice/callerDisplay.js", () => ({ resolveDisplayName: vi.fn(async () => "Someone") }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../modules/presence/presenceService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/presence/presenceService.js")>()),
  syncStaffOnCallFromConferences: vi.fn(async () => undefined),
}));

import { claimInboundCall, findCallForStaff, parentSidFromRecordName, staffUserForIdentity } from "../modules/calls/callAttribution.js";
import { dialPendingCallees, endStaffLegsWithMessage, handleUnansweredCallee, ringbackAudio, ringbackTwiml, unansweredMessage } from "../voice/outboundCallFlow.js";
import { normalizeClientEvents } from "../modules/calls/dialerClientEvents.js";

const PARENT = "CA" + "1".repeat(32);
const LEG = "CA" + "2".repeat(32);
const db = (rules: Parameters<typeof answerBySql>[0]) => ({ query: vi.fn(answerBySql(rules)) });

beforeEach(() => {
  h.queryMock.mockReset();
  h.dialPstn.mockClear();
  h.dialPending.mockClear();
  h.unanswered.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("who answered an inbound call", () => {
  it("knows the staff member behind a Twilio identity", async () => {
    expect(await staffUserForIdentity(db([]), STAFF_USER_ID)).toBe(STAFF_USER_ID);
    expect(await staffUserForIdentity(db([[/FROM staff_presence WHERE twilio_identity/, { rows: [{ user_id: STAFF_USER_ID }] }]]), "client:todd-device")).toBe(STAFF_USER_ID);
    expect(await staffUserForIdentity(db([]), "")).toBeNull();
  });

  it("stamps the caller's call_logs row with the staff member and their leg", async () => {
    const q = db([[/UPDATE call_logs\s+SET staff_user_id/, { rows: [{ id: "log-1" }], rowCount: 1 }]]);
    expect(await claimInboundCall(q, { parentCallSid: PARENT, answeredLegSid: LEG, identity: STAFF_USER_ID })).toBe(true);
    expect(callsMatching(q.query, /UPDATE call_logs/)[0]![1]).toEqual([PARENT, LEG, STAFF_USER_ID]);
    expect(await claimInboundCall(q, { parentCallSid: null, answeredLegSid: LEG })).toBe(false);
  });

  it("reads the caller's sid from the call record name", () => {
    expect(parentSidFromRecordName(`rx_${PARENT}`)).toBe(PARENT);
    expect(parentSidFromRecordName("wb_x")).toBeNull();
  });

  it("finds the call from the dialler's own leg sid, and claims an unattributed one", async () => {
    const q = db([
      [/WITH my_identities/, { rows: [{ id: "log-1", contact_id: "c-1", silo: "BF", staff_user_id: null }] }],
      [/UPDATE call_logs SET staff_user_id = \$2::uuid/, { rows: [] }],
    ]);
    expect(await findCallForStaff(q, { kind: "sid", value: LEG }, STAFF_USER_ID)).toEqual({ id: "log-1", contactId: "c-1", silo: "BF" });
    expect(callsMatching(q.query, /UPDATE call_logs SET staff_user_id = \$2::uuid/)[0]![1]).toEqual(["log-1", STAFF_USER_ID, LEG]);
    expect(await findCallForStaff(db([[/WITH my_identities/, { rows: [] }]]), { kind: "sid", value: LEG }, STAFF_USER_ID)).toBeNull();
  });
});

describe("outbound call flow", () => {
  it("builds a playable ringback tone", () => {
    const wav = ringbackAudio();
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.length).toBe(44 + 8000 * 6 * 2);
    expect(ringbackTwiml("https://x.test")).toContain('<Play loop="0">https://x.test/api/webhooks/twilio/conference/ringback.wav</Play>');
  });

  it("says why an unanswered call ended", () => {
    expect(unansweredMessage("busy")).toBe("The line is busy.");
    expect(unansweredMessage("no-answer")).toBe("There was no answer.");
    expect(unansweredMessage("failed")).toBe("The call could not be completed.");
  });

  it("dials the waiting customer once, with the staff member's caller ID", async () => {
    const q = db([[/SET status = 'invited'/, { rows: [{ id: "pid-callee", phone_number: "+15875550100", friendly_name: "conf-friendly", created_by_user_id: STAFF_USER_ID }] }]]);
    const dialPstn = vi.fn(async () => ({ callSid: "CA-callee" }));
    expect(await dialPendingCallees("conf-1", { db: q, dialPstn, callerId: async () => "+18255550199" })).toBe(1);
    expect(dialPstn).toHaveBeenCalledWith({ conferenceId: "conf-1", conferenceFriendly: "conf-friendly", toNumber: "+15875550100", fromNumber: "+18255550199", participantId: "pid-callee" });
    expect(String(callsMatching(q.query, /SET status = 'invited'/)[0]![0])).toContain("p.status = 'pending_dial'");
  });

  it("a dial that fails ends the staff leg with the reason", async () => {
    const q = db([[/SET status = 'invited'/, { rows: [{ id: "pid-callee", phone_number: "+15875550100", friendly_name: "f", created_by_user_id: null }] }]]);
    const endStaff = vi.fn(async () => 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await dialPendingCallees("conf-1", { db: q, dialPstn: async () => { throw new Error("21217"); }, callerId: async () => "+1", endStaff })).toBe(0);
    expect(callsMatching(q.query, /SET status = 'failed'/)).toHaveLength(1);
    expect(endStaff).toHaveBeenCalledWith("conf-1", "The call could not be completed.");
    warn.mockRestore();
  });

  it("busy / no answer ends a 2-party call with the reason and keeps it on the row", async () => {
    const endStaff = vi.fn(async () => 1);
    const q = db([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/SELECT COUNT\(\*\)::int AS c FROM conference_participants/, { rows: [{ c: 0 }] }],
    ]);
    const part = { id: "pid-callee", conference_id: "conf-1", kind: "pstn", role: "participant", joined_at: null };
    expect(await handleUnansweredCallee(part, "busy", { db: q, endStaff })).toBe("busy");
    expect(callsMatching(q.query, /SET status = \$2, left_at = now\(\)/)[0]![1]).toEqual(["pid-callee", "busy"]);
    expect(endStaff).toHaveBeenCalledWith("conf-1", "The line is busy.");
  });

  it("does not end a call already in progress when an added person doesn't answer", async () => {
    const endStaff = vi.fn(async () => 1);
    const q = db([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/SELECT COUNT\(\*\)::int AS c FROM conference_participants/, { rows: [{ c: 1 }] }],
    ]);
    expect(await handleUnansweredCallee({ id: "p2", conference_id: "conf-1", kind: "pstn", role: "participant", joined_at: null }, "no-answer", { db: q, endStaff })).toBe("no-answer");
    expect(endStaff).not.toHaveBeenCalled();
  });

  it("leaves completed calls, inbound calls and the staff leg alone", async () => {
    const q = db([[/SELECT direction FROM conferences/, { rows: [{ direction: "inbound" }] }]]);
    const part = { id: "p", conference_id: "c", kind: "pstn", role: "participant", joined_at: null };
    expect(await handleUnansweredCallee(part, "completed", { db: q })).toBeNull();
    expect(await handleUnansweredCallee(part, "busy", { db: q })).toBeNull();
    expect(await handleUnansweredCallee({ ...part, role: "moderator" }, "busy", { db: q })).toBeNull();
    expect(await handleUnansweredCallee({ ...part, joined_at: "2026-10-19" }, "failed", { db: q })).toBeNull();
  });

  it("tells each staff leg why, then hangs up", async () => {
    const update = vi.fn(async () => ({}));
    const calls = vi.fn(() => ({ update }));
    const q = db([[/SELECT twilio_call_sid FROM conference_participants/, { rows: [{ twilio_call_sid: "CA-staff" }] }]]);
    expect(await endStaffLegsWithMessage("conf-1", "The line is busy.", { db: q, twilio: async () => ({ calls }) })).toBe(1);
    expect(calls).toHaveBeenCalledWith("CA-staff");
    expect(update).toHaveBeenCalledWith({ twiml: '<Response><Say voice="Polly.Joanna">The line is busy.</Say><Hangup/></Response>' });
  });
});

describe("POST /api/voice/calls with dialOnJoin", () => {
  async function app() {
    h.queryMock.mockImplementation(answerBySql([[/SELECT direct_number FROM users/, { rows: [{ direct_number: null }] }]]));
    const { default: router } = await import("../routes/voiceCalls.js");
    const a = express();
    a.use(express.json());
    a.use("/api/voice", router);
    return a;
  }

  it("does not dial the customer until the staff leg joins", async () => {
    const res = await request(await app()).post("/api/voice/calls").set("Authorization", bearer("Staff")).send({ to: "+15875550100", dialOnJoin: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, conferenceFriendly: "conf-friendly", calleeParticipantId: "pid-pending", dialOnJoin: true, calleeCallSid: null });
    expect(h.dialPstn).not.toHaveBeenCalled();
  });

  it("the portal (no flag) still dials at once", async () => {
    const res = await request(await app()).post("/api/voice/calls").set("Authorization", bearer("Staff")).send({ to: "+15875550100" });
    expect(res.status).toBe(200);
    expect(h.dialPstn).toHaveBeenCalledTimes(1);
  });
});

describe("conference webhooks", () => {
  async function hooks(rules: Parameters<typeof answerBySql>[0]) {
    h.queryMock.mockImplementation(answerBySql(rules));
    const { default: router } = await import("../routes/conferenceWebhooks.js");
    const a = express();
    a.use("/api/webhooks/twilio", router);
    return a;
  }
  const join = (a: express.Express, pid: string) => request(a).post(`/api/webhooks/twilio/conference/join?conf=conf-friendly&pid=${pid}`).type("form").send({ CallSid: LEG, From: "client:x" });

  it("the staff member who placed the call waits hearing ringback, with no recording notice", async () => {
    const a = await hooks([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/FROM conference_participants p WHERE p\.id = \$1/, { rows: [{ kind: "staff", role: "moderator", identity: STAFF_USER_ID, conference_id: "conf-1", others_joined: 0 }] }],
    ]);
    const res = await join(a, "pid-staff");
    expect(res.text).toContain('startConferenceOnEnter="false"');
    expect(res.text).toContain("/api/webhooks/twilio/conference/ringback");
    expect(res.text).not.toContain("may be recorded");
    expect(res.text).toContain("record-from-start");
  });

  it("the customer hears the notice and starts the conference", async () => {
    const a = await hooks([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/FROM conference_participants p WHERE p\.id = \$1/, { rows: [{ kind: "pstn", role: "participant", identity: null, conference_id: "conf-1", others_joined: 1 }] }],
    ]);
    const res = await join(a, "pid-callee");
    expect(res.text).toContain("may be recorded");
    expect(res.text).toContain('startConferenceOnEnter="true"');
    expect(res.text).not.toContain("ringback");
  });

  it("a ring-all answer records who answered on the inbound call", async () => {
    const a = await hooks([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "inbound" }] }],
      [/FROM conference_participants p WHERE p\.id = \$1/, { rows: [{ kind: "staff", role: "participant", identity: STAFF_USER_ID, conference_id: "conf-1", others_joined: 1 }] }],
      [/kind <> 'staff' AND twilio_call_sid IS NOT NULL ORDER BY created_at/, { rows: [{ sid: PARENT }] }],
      [/UPDATE call_logs\s+SET staff_user_id/, { rows: [{ id: "log-1" }], rowCount: 1 }],
    ]);
    const res = await join(a, "pid-staff");
    expect(res.text).not.toContain("may be recorded");
    await vi.waitFor(() => expect(callsMatching(h.queryMock, /UPDATE call_logs\s+SET staff_user_id/)[0]?.[1]).toEqual([PARENT, LEG, STAFF_USER_ID]));
  });

  it("serves the ringback TwiML and the tone", async () => {
    const a = await hooks([]);
    const twiml = await request(a).post("/api/webhooks/twilio/conference/ringback").type("form").send({});
    expect(twiml.text).toContain("<Play loop=\"0\">");
    const wav = await request(a).get("/api/webhooks/twilio/conference/ringback.wav");
    expect(wav.headers["content-type"]).toContain("audio/wav");
    expect(wav.body.length).toBe(ringbackAudio().length);
  });

  it("a busy customer is recorded as busy, not just 'left'", async () => {
    const a = await hooks([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/SELECT COUNT\(\*\)::int AS c FROM conference_participants/, { rows: [{ c: 0 }] }],
      [/SELECT twilio_call_sid FROM conference_participants/, { rows: [] }],
    ]);
    const res = await request(a).post("/api/webhooks/twilio/call/status").type("form").send({ CallSid: "CA-callee", CallStatus: "busy" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.queryMock, /SET status = \$2, left_at = now\(\) WHERE id = \$1$/m)[0]?.[1]).toEqual(["pid-callee", "busy"]);
    expect(callsMatching(h.queryMock, /SET status = \$2, left_at = CASE/)).toHaveLength(0);
  });
});

describe("the dialler's own call events", () => {
  it("keeps well-formed events only", () => {
    const now = Date.parse("2026-10-19T22:00:00Z");
    const out = normalizeClientEvents([
      { event: "answer_tapped", at: "2026-10-19T21:59:00Z", callRef: LEG, metadata: { ms: 12, line: "BF" } },
      { event: "bad name!", at: "2026-10-19T21:59:00Z" },
      { event: "future", at: "2026-10-25T00:00:00Z" },
      "nope",
    ], now);
    expect(out).toEqual([{ event: "answer_tapped", call_ref: LEG, metadata: { ms: "12", line: "BF" }, occurred_at: "2026-10-19T21:59:00.000Z" }]);
    expect(normalizeClientEvents(null)).toEqual([]);
  });

  it("stores them for the signed-in staff member", async () => {
    h.queryMock.mockImplementation(answerBySql([[/INSERT INTO dialer_client_events/, { rows: [] }]]));
    const { default: router } = await import("../telephony/routes/telephonyRoutes.js");
    const a = express();
    a.use(express.json());
    a.use("/api/telephony", router);
    const res = await request(a).post("/api/telephony/client-events").set("Authorization", bearer("Staff"))
      .send({ appVersion: "1.0 (42)", events: [{ event: "call_connected", at: new Date().toISOString(), callRef: LEG, metadata: { answerMs: 900 } }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: 1 });
    const params = callsMatching(h.queryMock, /INSERT INTO dialer_client_events/)[0]![1] as unknown[];
    expect(params.slice(0, 2)).toEqual([STAFF_USER_ID, "1.0 (42)"]);
    const empty = await request(a).post("/api/telephony/client-events").set("Authorization", bearer("Staff")).send({ events: [] });
    expect(empty.status).toBe(400);
  });

  it("saves a call outcome from the dialler's leg sid (the incident on Oct 19)", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/WITH my_identities/, { rows: [{ id: "11111111-1111-4111-8111-111111111111", contact_id: null, silo: "BF", staff_user_id: STAFF_USER_ID }] }],
      [/UPDATE call_logs SET disposition/, { rows: [], rowCount: 1 }],
    ]));
    const { default: router } = await import("../telephony/routes/telephonyRoutes.js");
    const a = express();
    a.use(express.json());
    a.use("/api/telephony", router);
    const res = await request(a).post(`/api/telephony/calls/${LEG}/disposition`).set("Authorization", bearer("Staff")).send({ disposition: "connected" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ disposition: "connected", followUpCreated: false });
    const missing = await (async () => {
      h.queryMock.mockImplementation(answerBySql([[/WITH my_identities/, { rows: [] }]]));
      return request(a).post(`/api/telephony/calls/${LEG}/disposition`).set("Authorization", bearer("Staff")).send({ disposition: "connected" });
    })();
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: "call_not_found", message: expect.stringContaining("isn't linked to you") });
  });
});
