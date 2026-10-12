// BF_SERVER_v786_ROOM_RECORDINGS - conference rooms: status webhook creates the conference and its
// participants, matches them to contacts (an unknown caller becomes a contact), the recording is
// linked to every participant and attendee contact, and meeting.completed fires at the end.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";

const ROOM = "99999999-9999-4999-8999-999999999999";
type Row = Record<string, any>;
const db = {
  conferences: [] as Row[], participants: [] as Row[], contacts: [] as Row[], meetingParticipants: [] as Row[], recordings: [] as Row[], links: [] as Row[],
  room: { id: ROOM, title: "Deal review", silo: "BF", contact_id: "c-room", application_id: "app-1", host_user_id: "u-host" } as Row,
};
const last10 = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "").slice(-10);
const q = vi.fn(async (sql: string, p: any[] = []) => {
  if (sql.includes("FROM meeting_rooms WHERE id::text = $1")) return { rows: p[0] === ROOM ? [db.room] : [] };
  // Ends the transcript poll right after the transcript is requested (no 6-second wait in a test).
  if (sql.startsWith("INSERT INTO call_transcripts")) throw new Error("test: stop transcript polling");
  if (sql.includes("FROM meeting_rooms WHERE code = $1")) return { rows: p[0] === "482913" ? [{ ...db.room, code: "482913", starts_at: new Date().toISOString(), duration_min: 60, status: "scheduled" }] : [] };
  if (sql.includes("FROM conferences WHERE meeting_room_id::text = $1 AND ended_at IS NULL")) return { rows: db.conferences.filter((c) => c.meeting_room_id === p[0] && !c.ended_at).map((c) => ({ id: c.id })) };
  if (sql.startsWith("INSERT INTO conferences")) {
    if (db.conferences.some((c) => c.meeting_room_id === p[6] && !c.ended_at)) return { rows: [] };
    const c = { id: `conf-${db.conferences.length + 1}`, twilio_conference_sid: p[0], friendly_name: p[1], silo: p[2], contact_id: p[5], meeting_room_id: p[6], ended_at: null };
    db.conferences.push(c);
    return { rows: [{ id: c.id }] };
  }
  if (sql.startsWith("UPDATE conferences SET twilio_conference_sid")) return { rows: [] };
  if (sql.includes("FROM contacts") && sql.includes("secondary_phone")) {
    return { rows: db.contacts.filter((c) => c.silo === p[0] && (last10(c.phone) === last10(p[1]) || last10(c.secondary_phone) === last10(p[1]))).map((c) => ({ id: c.id })) };
  }
  if (sql.startsWith("INSERT INTO contacts")) { const c = { id: `c-new-${db.contacts.length}`, name: p[0], phone: p[1], silo: p[2], tags: ["conference_caller"] }; db.contacts.push(c); return { rows: [{ id: c.id }] }; }
  if (sql.includes("FROM users WHERE id::text = $1")) return { rows: p[0] === "u-staff" || p[1] === "u-staff" ? [{ id: "u-staff" }] : [] };
  if (sql.startsWith("INSERT INTO conference_participants")) {
    db.participants.push({ conference_id: p[0], call_sid: p[1], identity: p[2], phone: p[3], kind: p[4], contact_id: p[5], user_id: p[6], status: "joined" });
    return { rows: [] };
  }
  if (sql.startsWith("UPDATE conference_participants SET status = 'left', left_at = now() WHERE twilio_call_sid")) {
    for (const x of db.participants) if (x.call_sid === p[0]) x.status = "left";
    return { rows: [] };
  }
  if (sql.startsWith("UPDATE conferences SET status = 'completed'")) { for (const c of db.conferences) if (c.id === p[0]) c.ended_at = "now"; return { rows: [] }; }
  if (sql.includes("SELECT DISTINCT x.contact_id")) {
    const conf = db.conferences.find((c) => c.id === p[0]);
    const ids = new Set<string>();
    for (const x of db.participants) if (x.conference_id === p[0] && x.contact_id) ids.add(x.contact_id);
    for (const m of db.meetingParticipants) {
      if (m.contact_id) ids.add(m.contact_id);
      if (m.email) for (const c of db.contacts) if (c.email && c.email.toLowerCase() === m.email.toLowerCase() && c.silo === db.room.silo) ids.add(c.id);
    }
    if (conf && db.room.contact_id) ids.add(db.room.contact_id);
    return { rows: [...ids].map((contact_id) => ({ contact_id })) };
  }
  if (sql.startsWith("INSERT INTO call_recording_contacts")) {
    let n = 0;
    for (const r of db.recordings.filter((x) => x.conference_id === p[0])) for (const c of p[1]) {
      if (!db.links.some((l) => l.recording_id === r.id && l.contact_id === c)) { db.links.push({ recording_id: r.id, contact_id: c }); n++; }
    }
    return { rows: [], rowCount: n };
  }
  return { rows: [], rowCount: 0 };
});
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  const query = (sql: string, p?: unknown[]) => q(sql, p as any[]);
  return { ...actual, pool: { query }, runQuery: query, dbQuery: query, query };
});
// Twilio signs every webhook; these tests sign requests with the real library.
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
const tw = vi.hoisted(() => ({ create: vi.fn(async () => ({ sid: "GT1" })) }));
vi.mock("../voice/twilioClient.js", async (orig) => ({
  ...(await orig<typeof import("../voice/twilioClient.js")>()),
  getTwilio: () => ({ intelligence: { v2: { transcripts: Object.assign(() => ({ fetch: async () => ({ status: "failed" }) }), { create: tw.create }) } } }),
}));
vi.mock("../voice/conferenceService.js", async (orig) => ({
  ...(await orig<typeof import("../voice/conferenceService.js")>()),
  getConferenceByFriendly: vi.fn(async () => (db.conferences[0] ? { id: db.conferences[0].id, meeting_room_id: ROOM } : null)),
  notifyConferenceState: vi.fn(async () => undefined),
}));
vi.mock("../services/mmsMedia.js", async (orig) => ({
  ...(await orig<typeof import("../services/mmsMedia.js")>()),
  persistTwilioMediaToBlob: vi.fn(async () => null),
}));
const emitAutomationEvent = vi.fn(async () => undefined);
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: (...a: any[]) => (emitAutomationEvent as any)(...a) }));

import { handleRoomStatus, linkRoomRecordings, toE164 } from "../services/meetingRoomConference.js";
import { roomConferenceAttrs, staffRoomJoinTwiml, conferenceName } from "../services/meetingRooms.js";

const ev = (event: string, callSid: string | null, from: string | null) => handleRoomStatus({ roomId: ROOM, event, callSid, conferenceSid: "CF1", from });

describe("conference room status webhook", () => {
  beforeEach(() => {
    db.conferences = []; db.participants = []; db.recordings = []; db.links = [];
    db.contacts = [
      { id: "c-known", silo: "BF", phone: "(780) 555-1212", secondary_phone: null, email: "known@example.com" },
      { id: "c-second", silo: "BF", phone: null, secondary_phone: "403-555-0000", email: null },
      { id: "c-attendee", silo: "BF", phone: null, email: "Attendee@Example.com" },
    ];
    db.meetingParticipants = [{ room_id: ROOM, contact_id: null, email: "attendee@example.com" }, { room_id: ROOM, contact_id: "c-invited", email: null }];
    emitAutomationEvent.mockClear();
  });

  it("creates one conferences row on the first join and records every participant, matched", async () => {
    await ev("conference-start", null, null);
    await ev("participant-join", "CA1", "+17805551212");
    await ev("participant-join", "CA2", "+1 403 555 0000");
    await ev("participant-join", "CA3", "client:u-staff");
    await ev("participant-join", "CA4", "+15875550199");
    expect(db.conferences).toHaveLength(1);
    expect(db.conferences[0]).toMatchObject({ friendly_name: conferenceName(ROOM), meeting_room_id: ROOM, silo: "BF", contact_id: "c-room" });
    expect(db.participants.map((x) => [x.call_sid, x.kind, x.contact_id, x.user_id])).toEqual([
      ["CA1", "pstn", "c-known", null],
      ["CA2", "pstn", "c-second", null],
      ["CA3", "staff", null, "u-staff"],
      ["CA4", "pstn", "c-new-3", null],
    ]);
    // an unknown phone caller becomes a contact in the room's silo
    expect(db.contacts.at(-1)).toMatchObject({ name: "Caller +15875550199", phone: "+15875550199", silo: "BF", tags: ["conference_caller"] });
    expect(emitAutomationEvent).toHaveBeenCalledWith("contact.created", expect.objectContaining({ contactId: "c-new-3", data: expect.objectContaining({ source: "conference" }) }));
  });

  it("links the room recording to every participant and attendee contact, and fires meeting.completed at the end", async () => {
    await ev("participant-join", "CA1", "+17805551212");
    await ev("participant-join", "CA4", "+15875550199");
    db.recordings.push({ id: "rec-1", conference_id: db.conferences[0]!.id });
    await linkRoomRecordings(db.conferences[0]!.id);
    await ev("participant-leave", "CA1", null);
    expect(db.participants[0]!.status).toBe("left");
    await ev("conference-end", null, null);
    const linked = db.links.filter((l) => l.recording_id === "rec-1").map((l) => l.contact_id).sort();
    expect(linked).toEqual(["c-attendee", "c-invited", "c-known", "c-new-3", "c-room"].sort());
    expect(db.conferences[0]!.ended_at).toBeTruthy();
    const completed = emitAutomationEvent.mock.calls.filter((c: any[]) => c[0] === "meeting.completed").map((c: any[]) => c[1].contactId).sort();
    expect(completed).toEqual(linked);
    // a later session in the same room gets a new conference row
    await ev("participant-join", "CA9", "+17805551212");
    expect(db.conferences).toHaveLength(2);
  });

  it("normalizes caller numbers and ignores client identities as phones", () => {
    expect(toE164("(780) 555-1212")).toBe("+17805551212");
    expect(toE164("client:u-1")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});

describe("room TwiML and routes", () => {
  it("both <Conference> builders record and call the status and recording routes", async () => {
    const a = roomConferenceAttrs("r1", "+17805551212");
    expect(a).toMatchObject({ record: "record-from-start", statusCallbackEvent: "start end join leave", statusCallbackMethod: "POST" });
    expect(String(a.statusCallback)).toContain("/api/webhooks/twilio/meeting-room-status?room=r1&from=%2B17805551212");
    expect(String(a.recordingStatusCallback)).toContain("/api/webhooks/twilio/recording/status?conf=" + conferenceName("r1"));
    const start = new Date("2026-10-05T20:30:00Z");
    const xml = await staffRoomJoinTwiml({ id: "r1", code: "1", slug: "s", title: "T", host_user_id: null, application_id: null, contact_id: null, starts_at: start.toISOString(), duration_min: 30, status: "scheduled" }, start, "client:u-staff");
    expect(xml).toContain('record="record-from-start"');
    expect(xml).toContain("meeting-room-status?room=r1&amp;from=client%3Au-staff");
    expect(xml).toContain("recording/status?conf=" + conferenceName("r1"));
  });

  it("the 866 meeting-code step joins with the same recorded room attributes", async () => {
    const res = await signedPost("/api/webhooks/twilio/reception", "../routes/reception.js", "/meeting-code", { Digits: "482913", From: "+17805551212", CallSid: "CA1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('record="record-from-start"');
    expect(res.text).toContain("meeting-room-status?room=" + ROOM + "&amp;from=%2B17805551212");
    expect(res.text).toContain("recording/status?conf=" + conferenceName(ROOM));
    expect(res.text).toContain(">" + conferenceName(ROOM) + "</Conference>");
  });
});

// Signs a webhook the way Twilio does, against a fixed public URL.
async function signedPost(mount: string, modPath: string, path: string, params: Record<string, string>, signed = true) {
  const router = (await import(modPath)).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mount, router);
  const full = mount + path;
  let r = request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https");
  if (signed) r = r.set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params));
  return r.send(params);
}

describe("room webhooks", () => {
  beforeEach(() => {
    db.conferences = []; db.participants = []; db.recordings = []; db.links = []; db.contacts = []; db.meetingParticipants = [];
    tw.create.mockClear();
  });

  it("the status route is Twilio-signed", async () => {
    const path = "/twilio/meeting-room-status?room=" + ROOM;
    const unsigned = await signedPost("/api/webhooks", "../routes/webhooks.js", path, { StatusCallbackEvent: "participant-join", CallSid: "CA1", ConferenceSid: "CF1", From: "+17805551212" }, false);
    expect(unsigned.status).toBe(403);
    expect(db.conferences).toHaveLength(0);
    const signed = await signedPost("/api/webhooks", "../routes/webhooks.js", path, { StatusCallbackEvent: "participant-join", CallSid: "CA1", ConferenceSid: "CF1", From: "+17805551212" });
    expect(signed.status).toBe(200);
    expect(db.conferences).toHaveLength(1);
    expect(db.participants.map((x) => x.call_sid)).toEqual(["CA1"]);
  });

  it("the recording route links room recordings and transcribes them", async () => {
    process.env.VOICE_INTELLIGENCE_SERVICE_SID = "GA00000000000000000000000000000000";
    await ev("participant-join", "CA1", "+17805551212");
    db.recordings.push({ id: "rec-1", conference_id: db.conferences[0]!.id });
    const res = await signedPost("/api/webhooks/twilio", "../routes/recordingWebhooks.js", "/recording/status?conf=" + conferenceName(ROOM), {
      RecordingSid: "RE1", RecordingStatus: "completed", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "60",
    });
    expect(res.status).toBe(200);
    expect(db.links.map((l) => l.contact_id).sort()).toEqual(["c-new-0", "c-room"]);
    // transcription runs for every completed recording, room recordings included
    await vi.waitFor(() => expect(tw.create).toHaveBeenCalledWith({ serviceSid: "GA00000000000000000000000000000000", channel: { media_properties: { source_sid: "RE1" } } }));
    delete process.env.VOICE_INTELLIGENCE_SERVICE_SID;
  });
});
