// BF_SERVER_BOOKING_TEAMS_v1 - the Personal Guarantee Insurance team page: Todd and Andrew in turn, 10am to 6pm
// Eastern, a 15-minute phone call or a 30-minute Teams meeting.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { answerBySql } from "./helpers/answerBySql.js";

const q = vi.fn();
const graph = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = (sql: string, params?: unknown[]) => q(sql, params);
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: query, runQuery: query, query };
});
vi.mock("../services/teams/graphAppClient.js", async (orig) => ({
  ...(await orig<any>()),
  isAppGraphConfigured: () => true,
  graphAppFetch: (path: string, init?: RequestInit) => graph.fetch(path, init),
}));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../services/teams/inAppMeetings.js", () => ({ registerBookingTeamsMeeting: async () => undefined }));
vi.mock("../services/teams/autoRecord.js", () => ({ enableAutoRecording: async () => undefined }));

import { openSlots, createBooking, staffPool, type Staff } from "../services/clientBooking.js";
import { BOOKING_TEAMS, bookingTeam, forwardTeamLead, repCode, teamHours, teamMembers } from "../booking/teams.js";
import { createApp } from "../app.js";

const todd: Staff = { id: "t", email: "todd.w@boreal.financial", first_name: "Todd", signed_in: true, mailbox: "todd.w@boreal.financial" };
const andrew: Staff = { id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" };
const sam: Staff = { id: "s", email: "sam@boreal.financial", first_name: "Sam", signed_in: true, mailbox: "sam@boreal.financial" };
const pgi = BOOKING_TEAMS.pgi!;
const NOW = new Date("2026-11-16T12:00:00Z"); // Monday, 7am Eastern
const HOURS = teamHours(pgi, NOW);
const NEW_CONTACT: [RegExp, { rows: unknown[] }] = [/INSERT INTO contacts/, { rows: [{ id: "c1" }] }];
const quietGraph = () => graph.fetch.mockImplementation(async (path: string) => path.endsWith("/calendar/getSchedule")
  ? new Response(JSON.stringify({ value: [] }), { status: 200 })
  : new Response(JSON.stringify({ id: "ev1", onlineMeeting: { joinUrl: "https://teams.example/j" } }), { status: 201 }));

beforeEach(() => { q.mockReset(); q.mockImplementation(answerBySql([[/FROM users/, { rows: [andrew, sam, todd] }], NEW_CONTACT])); graph.fetch.mockReset(); quietGraph(); });
afterEach(() => { vi.useRealTimers(); delete process.env.BI_SERVER_URL; });

describe("the PGI booking team", () => {
  it("is Todd and Andrew, and nobody else", () => {
    expect(teamMembers(pgi, [andrew, sam, todd]).map((s) => s.id).sort()).toEqual(["a", "t"]);
    expect(staffPool([andrew, sam, todd], null, pgi.emails).map((s) => s.id).sort()).toEqual(["a", "t"]);
    expect(staffPool([andrew, sam, todd], null, null).map((s) => s.id).sort()).toEqual(["s", "t"]); // the Intake team is unchanged
    expect(bookingTeam("PGI")?.slug).toBe("pgi");
    expect(bookingTeam("constructor")).toBeNull();
  });

  it("keeps Eastern hours in winter and in summer", () => {
    expect(teamHours(pgi, new Date("2026-11-16T12:00:00Z"))[1]).toEqual([["09:00", "17:00"]]); // Eastern is 1 hour ahead of Alberta
    expect(teamHours(pgi, new Date("2026-07-15T12:00:00Z"))[1]).toEqual([["08:00", "16:00"]]); // and 2 hours ahead in summer
    expect(teamHours(pgi, NOW)[0]).toEqual([]);
  });

  it("offers 10am to 6pm Eastern on weekdays: a 15-minute call can start at 5:30pm, a 30-minute meeting too, nothing at 6pm", async () => {
    const phone = await openSlots(NOW, null, 1, pgi.types.phone, HOURS, pgi.emails);
    const starts = phone.map((s) => s.startsAt).filter((s) => s.startsWith("2026-11-16"));
    expect(starts[0]).toBe("2026-11-16T15:00:00.000Z");              // 10:00 Eastern
    expect(starts[starts.length - 1]).toBe("2026-11-16T22:30:00.000Z"); // 5:30pm Eastern
    expect(phone[0]!.staffIds.sort()).toEqual(["a", "t"]);
    const teams = (await openSlots(NOW, null, 1, pgi.types.teams, HOURS, pgi.emails)).map((s) => s.startsAt).filter((s) => s.startsWith("2026-11-16"));
    expect(teams[teams.length - 1]).toBe("2026-11-16T22:30:00.000Z");
    expect(teams).not.toContain("2026-11-16T23:00:00.000Z");
  });

  it("when Todd is busy the time is still offered, and goes to Andrew's calendar", async () => {
    graph.fetch.mockImplementation(async (path: string) => path.endsWith("/calendar/getSchedule")
      ? new Response(JSON.stringify({ value: [{ scheduleId: "todd.w@boreal.financial", scheduleItems: [{ status: "busy", start: { dateTime: "2026-11-16T15:00:00" }, end: { dateTime: "2026-11-16T16:00:00" } }] }] }), { status: 200 })
      : new Response(JSON.stringify({ id: "ev1" }), { status: 201 }));
    const out = await createBooking({ kind: "phone", startsAt: new Date("2026-11-16T15:00:00Z"), staffId: null, name: "Pat Example", email: "pat@example.com", phone: "2125550142", notes: null, now: NOW,
      meetingType: pgi.types.phone, hours: HOURS, teamEmails: pgi.emails, teamLabel: pgi.label, extraTags: ["pgi_booking", "rep:ab12cd"] });
    expect(out.ok && out.booking.staffFirstName).toBe("Andrew");
    expect(out.ok && out.booking.durationMin).toBe(15);
    const event = graph.fetch.mock.calls.find((c) => String(c[0]).endsWith("/events"))!;
    expect(String(event[0])).toContain(encodeURIComponent("andrew.p@boreal.financial"));
    expect(JSON.parse(String(event[1].body)).subject).toBe("Phone call with Pat Example - Personal Guarantee Insurance");
    const contact = q.mock.calls.find((c) => /INSERT INTO contacts/.test(String(c[0])))!;
    expect(contact[1][5]).toEqual(["booked_call", "pgi_booking", "rep:ab12cd"]);
  });

  it("whoever was booked longer ago goes next", async () => {
    q.mockImplementation(answerBySql([[/FROM users/, { rows: [andrew, sam, todd] }], NEW_CONTACT, [/max\(created_at\) AS last_at/, { rows: [{ staff_user_id: "a", last_at: "2026-11-10T00:00:00Z" }, { staff_user_id: "t", last_at: "2026-11-01T00:00:00Z" }] }]]));
    const out = await createBooking({ kind: "teams", startsAt: new Date("2026-11-16T16:00:00Z"), staffId: null, name: "Pat Example", email: "pat@example.com", phone: null, notes: null, now: NOW,
      meetingType: pgi.types.teams, hours: HOURS, teamEmails: pgi.emails, teamLabel: pgi.label });
    expect(out.ok && out.booking.staffFirstName).toBe("Todd");
  });

  it("a booking is passed to Boreal Insurance as a lead, with the rep who gets the credit", async () => {
    process.env.BI_SERVER_URL = "https://bi.example/";
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await forwardTeamLead(pgi, { name: "Pat Example", email: "pat@example.com", phone: "+12125550142", rep: "ab12cd" }, f as any)).toBe(true);
    expect(f.mock.calls[0]![0]).toBe("https://bi.example/api/v1/crm/lead");
    expect(JSON.parse(String((f.mock.calls[0] as any)[1].body))).toMatchObject({ source: "us_lenders_quick", name: "Pat Example", email: "pat@example.com", phone: "+12125550142", rep: "ab12cd" });
    const down = vi.fn(async () => { throw new Error("down"); });
    expect(await forwardTeamLead(pgi, { name: "P", email: "p@example.com", phone: null, rep: null }, down as any)).toBe(false);
    expect(repCode("AB12cd")).toBe("ab12cd");
    expect(repCode("x y")).toBeNull();
  });

  it("the public endpoints: slots for the team, and an unknown team is a 404", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const app = createApp();
    const r = await request(app).get("/api/booking/slots?team=pgi&kind=phone");
    expect(r.status).toBe(200);
    expect(r.body.meetingType).toMatchObject({ duration_min: 15, kind: "phone" });
    expect(r.body.team).toEqual({ slug: "pgi", label: "Personal Guarantee Insurance" });
    expect(r.body.slots[0].startsAt).toBe("2026-11-16T15:00:00.000Z");
    expect((await request(app).get("/api/booking/slots?team=pgi&kind=teams")).body.meetingType.duration_min).toBe(30);
    expect((await request(app).get("/api/booking/slots?team=nobody")).status).toBe(404);
    expect((await request(app).post("/api/booking").send({ team: "nobody", kind: "phone", name: "P", email: "p@example.com", startsAt: "2026-11-16T15:00:00Z" })).status).toBe(404);
    expect((await request(app).post("/api/booking").send({ team: "pgi", name: "P", email: "p@example.com", startsAt: "2026-11-16T15:00:00Z" })).status).toBe(400);
  });
});
