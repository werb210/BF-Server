// BF_SERVER_v827_CONFERENCE_DIAL - "3" and the access code in one go join the meeting with no digits lost, and the
// greeting heard back through a speakerphone is not taken as an answer.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { conferenceName } from "../services/meetingRooms.js";
import { looksLikeEcho } from "../routes/reception.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const room: any = { id: "22222222-2222-4222-8222-222222222222", code: "957630", slug: "ad075f314eeb", title: "test", host_user_id: null, application_id: null, contact_id: null, starts_at: new Date().toISOString(), duration_min: 30, status: "scheduled" };

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

describe("conference dial-in", () => {
  it("the greeting takes several keys ending with #", async () => {
    const g = await reception("/greeting", {});
    expect(g.text).toContain('numDigits="8"');
    expect(g.text).toContain('finishOnKey="#"');
  });

  it("3 followed by the code goes straight to that meeting", async () => {
    const company = await reception("/company", { Digits: "3957630" });
    expect(company.text).toContain("/api/webhooks/twilio/reception/meeting-code?try=0&amp;code=957630");
    h.query.mockImplementation(async (sql: string, p?: unknown[]) => ({ rows: /FROM meeting_rooms WHERE code = \$1/.test(sql) && p?.[0] === "957630" ? [room] : [] }));
    const joined = await reception("/meeting-code?try=0&code=957630", {});
    expect(joined.text).toContain(">" + conferenceName(room.id) + "</Conference>");
  });

  it("a single key still picks the menu", async () => {
    expect((await reception("/company", { Digits: "3" })).text).toContain("<Redirect method=\"POST\">/api/webhooks/twilio/reception/meeting</Redirect>");
    expect((await reception("/company", { Digits: "1" })).text).not.toContain("reception/meeting");
  });

  it("ignores the greeting heard back through a speakerphone, once", async () => {
    expect(looksLikeEcho("to join a scheduled meeting press 3")).toBe(true);
    expect(looksLikeEcho("Thank you for calling the Boreal Group of Companies")).toBe(true);
    expect(looksLikeEcho("meeting")).toBe(false);
    expect(looksLikeEcho("Boreal Financial please")).toBe(false);
    const first = await reception("/company", { SpeechResult: "to join a scheduled meeting press 3" });
    expect(first.text).toContain("/api/webhooks/twilio/reception/greeting?again=1");
    const second = await reception("/company?again=1", { SpeechResult: "to join a scheduled meeting press 3" });
    expect(second.text).not.toContain("reception/meeting");
    expect(second.text).not.toContain("greeting?again=1");
  });
});
