// BF_SERVER_v821_DIALER - the voicemail alert fires AFTER transcription, with the transcript and the voicemail id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), alert: vi.fn(), transcribe: vi.fn(), order: [] as string[] }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../modules/calls/calls.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/calls/calls.repo.js")),
  findCallLogByTwilioSid: async () => null,
}));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: async () => ({}) }));
vi.mock("../modules/crm/crmTimeline.service.js", () => ({ logCrmEvent: async () => undefined }));
vi.mock("openai", () => {
  const OpenAI = function () { return {}; } as any;
  OpenAI.toFile = async (buffer: unknown, name: string) => ({ buffer, name });
  return { default: OpenAI };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedOpenAI: () => ({ audio: { transcriptions: { create: async (args: unknown) => { h.order.push("transcribe"); return h.transcribe(args); } } } }),
}));
vi.mock("../services/notifications/staffAlertEvents.js", () => ({
  alertVoicemail: async (input: unknown) => { h.order.push("alert"); return h.alert(input); },
}));

import { config } from "../config/index.js";
import { enrichAndDistributeVoicemail } from "../modules/voice/voicemailEnrich.service.js";

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const VOICEMAIL = "f0f0f0f0-0000-4000-8000-000000000005";
const STAFF = "44444444-4444-4444-8444-444444444444";
let savedKey: string | undefined;

beforeEach(() => {
  h.query.mockReset(); h.alert.mockReset(); h.transcribe.mockReset(); h.order.length = 0;
  savedKey = config.openai.apiKey;
  (config.openai as any).apiKey = "test-key";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
  h.transcribe.mockResolvedValue({ text: "Hi, it's Jane. Please call me back about the equipment loan." });
  h.query.mockImplementation(answerBySql([
    [/FROM contacts\s+WHERE silo = \$2/, { rows: [{ id: CONTACT }] }],
    [/INSERT INTO voicemails/, () => { h.order.push("upsert"); return { rows: [{ id: VOICEMAIL }] }; }],
    [/INSERT INTO communications_conversations/, { rows: [{ id: "conv-1" }] }],
    [/INSERT INTO communications_messages/, { rows: [{ id: "msg-1" }] }],
  ]));
});
afterEach(() => { (config.openai as any).apiKey = savedKey; vi.unstubAllGlobals(); });

describe("voicemail enrichment -> staff alert", () => {
  it("alerts once, after the transcript and the voicemail row exist, with voicemailId", async () => {
    await enrichAndDistributeVoicemail({ callSid: "CA1", recordingSid: "RE1", recordingUrl: "https://api.twilio.com/rec/RE1", fromNumber: "+14035550144", staffUserId: STAFF });
    expect(h.order).toEqual(["transcribe", "upsert", "alert"]);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0][0]).toMatchObject({
      from: "+14035550144", staffUserId: STAFF, contactId: CONTACT, recordingSid: "RE1", voicemailId: VOICEMAIL,
      transcript: "Hi, it's Jane. Please call me back about the equipment loan.",
    });
    expect(callsMatching(h.query, /INSERT INTO voicemails[\s\S]*RETURNING id::text AS id/)).toHaveLength(1);
  });

  it("a failed upsert still alerts (without an id)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.query.mockImplementation(answerBySql([[/INSERT INTO voicemails/, new Error("db down")]]));
    await enrichAndDistributeVoicemail({ callSid: "CA2", recordingSid: "RE2", recordingUrl: "https://api.twilio.com/rec/RE2", fromNumber: "+14035550144" });
    expect(h.alert.mock.calls[0][0]).toMatchObject({ voicemailId: null });
  });
});
