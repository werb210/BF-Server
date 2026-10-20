// BF_SERVER_v830_DIALER_CONTROLS - dialler audit batch 2:
//   - Busy holds (going to the background no longer clears it) and covers the direct line
//   - transfers and 3-way calls keep the remaining people connected, and end once one person is left
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bearer } from "./helpers/staffToken.js";
import { mountRouter } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), dialPstn: vi.fn(async () => ({ callSid: "CA-new" })), prepare: vi.fn(async () => 1), endIfAlone: vi.fn(async () => false) }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../modules/calls/calls.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/calls/calls.service.js")),
  startCall: async () => ({ id: "call-1" }),
}));

import { endIfAlone, prepareMultiParty } from "../voice/multiParty.js";
import { ownerIsBusy } from "../voice/callHours.js";

const OWNER = "44444444-4444-4444-8444-444444444444";
const db = (rules: Parameters<typeof answerBySql>[0]) => ({ query: vi.fn(answerBySql(rules)) });

beforeEach(() => { h.query.mockReset(); vi.spyOn(console, "log").mockImplementation(() => undefined); });

describe("Busy", () => {
  it("going to the background no longer clears Busy or counts as being online", async () => {
    h.query.mockImplementation(answerBySql([[/UPDATE staff_presence SET last_heartbeat = LEAST/, { rows: [] }]]));
    const { default: router } = await import("../telephony/routes/telephonyRoutes.js");
    const app = express();
    app.use(express.json());
    app.use("/api/telephony", router);
    const res = await request(app).post("/api/telephony/presence").set("Authorization", bearer("Staff")).send({ status: "offline" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /SET manual_busy|manual_busy = \$2/)).toHaveLength(0);
    expect(callsMatching(h.query, /UPDATE staff_presence SET last_heartbeat = LEAST\(last_heartbeat, now\(\) - interval '10 minutes'\)/)).toHaveLength(1);
  });

  it("knows when a staff member is busy, and a failed lookup never blocks the call", async () => {
    expect(await ownerIsBusy(db([[/SELECT coalesce\(manual_busy/, { rows: [{ busy: true }] }]]), OWNER)).toBe(true);
    expect(await ownerIsBusy(db([[/SELECT coalesce\(manual_busy/, { rows: [] }]]), OWNER)).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await ownerIsBusy({ query: async () => { throw new Error("down"); } }, OWNER)).toBe(false);
    warn.mockRestore();
  });

  it("a busy owner's direct line offers press-1-if-urgent, then their voicemail", async () => {
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      [/SELECT coalesce\(manual_busy/, { rows: [{ busy: true }] }],
    ]));
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({ From: "+15875550142", To: "+18255550190", CallSid: "CA-busy-1" });
    expect(res.text).toContain("Pat is away right now");
    expect(res.text).toContain("press 1");
    expect(res.text).toContain(`away-choice?user=${OWNER}&amp;ring=direct`);
    expect(res.text).not.toContain("<Client");
  });
});

describe("transfers and 3-way calls", () => {
  it("switches the legs already in the call to stay when another leaves", async () => {
    const update = vi.fn(async () => ({}));
    const participants = vi.fn(() => ({ update }));
    const tw = { conferences: vi.fn(() => ({ update: vi.fn(), participants })) };
    const q = db([
      [/UPDATE conferences SET multi_party = true/, { rows: [{ twilio_conference_sid: "CF1" }] }],
      [/WHERE conference_id = \$1 AND status = 'joined'/, { rows: [{ twilio_call_sid: "CA-staff" }, { twilio_call_sid: "CA-client" }] }],
    ]);
    expect(await prepareMultiParty("conf-1", { db: q, twilio: async () => tw as any })).toBe(2);
    expect(participants.mock.calls.map((c) => c[0])).toEqual(["CA-staff", "CA-client"]);
    expect(update).toHaveBeenCalledWith({ endConferenceOnExit: false });
  });

  it("ends a 3-way call once one person is left, but not while someone is still being rung", async () => {
    const confUpdate = vi.fn(async () => ({}));
    const tw = { conferences: vi.fn(() => ({ update: confUpdate, participants: vi.fn() })) };
    const row = (over: Record<string, unknown>) => db([[/FROM conferences c WHERE c\.id = \$1/, { rows: [{ twilio_conference_sid: "CF1", status: "active", multi_party: true, joined: 1, coming: 0, ...over }] }]]);
    expect(await endIfAlone("conf-1", { db: row({}), twilio: async () => tw as any })).toBe(true);
    expect(confUpdate).toHaveBeenCalledWith({ status: "completed" });
    confUpdate.mockClear();
    expect(await endIfAlone("conf-1", { db: row({ joined: 2 }), twilio: async () => tw as any })).toBe(false);
    expect(await endIfAlone("conf-1", { db: row({ coming: 1 }), twilio: async () => tw as any })).toBe(false);
    expect(await endIfAlone("conf-1", { db: row({ multi_party: false }), twilio: async () => tw as any })).toBe(false);
    expect(await endIfAlone("conf-1", { db: row({ status: "ended" }), twilio: async () => tw as any })).toBe(false);
    expect(confUpdate).not.toHaveBeenCalled();
  });

  it("a leg added to a call in progress joins without ending the call when it leaves", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT direction FROM conferences/, { rows: [{ direction: "outbound" }] }],
      [/FROM conference_participants p WHERE p\.id = \$1/, { rows: [{ kind: "pstn", role: "participant", identity: null, conference_id: "conf-1", others_joined: 2 }] }],
    ]));
    const { default: router } = await import("../routes/conferenceWebhooks.js");
    const app = express();
    app.use("/api/webhooks/twilio", router);
    const multi = await request(app).post("/api/webhooks/twilio/conference/join?conf=c&pid=p&multi=1").type("form").send({ CallSid: "CA1" });
    expect(multi.text).toContain('endConferenceOnExit="false"');
    const plain = await request(app).post("/api/webhooks/twilio/conference/join?conf=c&pid=p").type("form").send({ CallSid: "CA1" });
    expect(plain.text).toContain('endConferenceOnExit="true"');
  });
});

describe("keypad tones on a Boreal call", () => {
  it("only plays digits, * # and pauses", async () => {
    const { validTones, tonesTwiml } = await import("../voice/conferenceTones.js");
    expect(validTones("123#")).toBe(true);
    expect(validTones("12w3")).toBe(true);
    expect(validTones("1<2")).toBe(false);
    expect(validTones("")).toBe(false);
    expect(tonesTwiml("123#")).toContain('<Play digits="123#"/>');
    expect(tonesTwiml('1"/><Hangup')).not.toContain("Hangup");
  });

  it("announces the tones to that participant's leg", async () => {
    const { sendTonesToParticipant } = await import("../voice/conferenceTones.js");
    const update = vi.fn(async () => ({}));
    const participants = vi.fn(() => ({ update }));
    await sendTonesToParticipant({ conferences: () => ({ participants }) } as any, "CF1", "CA-client", "123", "https://x.test");
    expect(participants).toHaveBeenCalledWith("CA-client");
    expect(update).toHaveBeenCalledWith({ announceUrl: "https://x.test/api/webhooks/twilio/conference/tones?d=123", announceMethod: "POST" });
  });

  it("serves the tones TwiML", async () => {
    h.query.mockImplementation(answerBySql([]));
    const { default: router } = await import("../routes/conferenceWebhooks.js");
    const app = express();
    app.use("/api/webhooks/twilio", router);
    const res = await request(app).post("/api/webhooks/twilio/conference/tones?d=55%23").type("form").send({});
    expect(res.text).toContain('<Play digits="55#"/>');
  });
});
