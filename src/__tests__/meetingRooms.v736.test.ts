// BF_SERVER_MEETING_ROOMS_v736
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { isOpen, oneTapDial, inviteText, conferenceName, roomConferenceAttrs } from "../services/meetingRooms.js";
import { joinPageHtml, icsFor } from "../routes/meetings.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const room: any = { id: "11111111-1111-4111-8111-111111111111", code: "482913", slug: "abc123def456", title: "Desklinx <review>", host_user_id: null, application_id: null, contact_id: null, starts_at: "2026-10-06T16:00:00Z", duration_min: 60, status: "scheduled" };

describe("meeting rooms", () => {
  it("are open from 15 minutes before to 2 hours after they end, and never when cancelled", () => {
    expect(isOpen(room, new Date("2026-10-06T15:44:00Z"))).toBe(false);
    expect(isOpen(room, new Date("2026-10-06T15:46:00Z"))).toBe(true);
    expect(isOpen(room, new Date("2026-10-06T18:59:00Z"))).toBe(true);
    expect(isOpen(room, new Date("2026-10-06T19:01:00Z"))).toBe(false);
    expect(isOpen({ ...room, status: "cancelled" }, new Date("2026-10-06T16:10:00Z"))).toBe(false);
  });
  it("one tap dials the 866, option 3, then the code", () => {
    expect(oneTapDial("482913")).toBe("+18666318939,,3482913#");
    expect(conferenceName(room.id)).toBe("boreal-meet-" + room.id);
  });
  it("the invite and join page give the number, option and code, with the title escaped", () => {
    expect(inviteText(room)).toContain("call (866) 631-8939, press 3, then enter access code 482913");
    const html = joinPageHtml(room);
    expect(html).toContain("Desklinx &lt;review&gt;");
    expect(html).toContain('<div class="code">482913</div>');
    expect(joinPageHtml(null)).toContain("This meeting isn't available");
  });
  it("produces a calendar file", () => {
    const ics = icsFor(room);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20261006T160000Z");
    expect(ics).toContain("code 482913");
  });
  it("the 866 greeting offers option 3 and the code steps join the conference", async () => {
    const greeting = await reception("/greeting", {});
    expect(greeting.text).toContain("To join a scheduled meeting, press 3.");

    for (const params of [{ Digits: "3" }, { SpeechResult: "I have a meeting" }, { SpeechResult: "the conference call" }]) {
      const company = await reception("/company", params);
      expect(company.text).toContain("<Redirect method=\"POST\">/api/webhooks/twilio/reception/meeting</Redirect>");
    }
    expect((await reception("/company", { Digits: "1" })).text).not.toContain("reception/meeting<");

    const prompt = await reception("/meeting", {});
    expect(prompt.text).toContain('numDigits="6"');
    expect(prompt.text).toContain("/api/webhooks/twilio/reception/meeting-code?try=0");

    const live = { ...room, starts_at: new Date().toISOString() };
    h.query.mockImplementation(async (sql: string, p?: unknown[]) => ({ rows: /FROM meeting_rooms WHERE code = \$1/.test(sql) && p?.[0] === "482913" ? [live] : [] }));
    const joined = await reception("/meeting-code", { Digits: "482913", From: "+17805551212" });
    // BF_SERVER_v786_ROOM_RECORDINGS - the attributes (record-from-start + status/recording callbacks) are shared.
    expect(joined.text).toContain(">" + conferenceName(room.id) + "</Conference>");
    expect(joined.text).toContain('startConferenceOnEnter="true"');
    expect(joined.text).toContain('record="record-from-start"');

    const wrong = await reception("/meeting-code", { Digits: "000000" });
    expect(wrong.text).toContain("/api/webhooks/twilio/reception/meeting?try=1");
    expect(wrong.text).not.toContain("<Conference");
  });

  it("every room conference starts on enter, survives a leaver, beeps and records", () => {
    expect(roomConferenceAttrs(room.id)).toMatchObject({ startConferenceOnEnter: true, endConferenceOnExit: false, beep: "onEnter", record: "record-from-start" });
  });
});

async function reception(path: string, params: Record<string, string>) {
  const router = (await import("../routes/reception.js")).default;
  const app = express();
  app.use("/api/webhooks/twilio/reception", router);
  const full = "/api/webhooks/twilio/reception" + path;
  const res = await request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res;
}
