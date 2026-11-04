// BF_SERVER_v888_TEAMS_IN_APP - join Teams meetings inside the portal and the client app.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const MEETING_ID = "33333333-3333-4333-8333-333333333333";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0";

const { queryMock, createUserAndToken, graphForUser, graphAppMock, autoRecordMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createUserAndToken: vi.fn(),
  graphForUser: vi.fn(),
  graphAppMock: vi.fn(),
  autoRecordMock: vi.fn(async () => undefined),
}));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { userId: STAFF_ID, role: "Staff" }; next(); },
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@azure/communication-identity", () => ({
  CommunicationIdentityClient: class { createUserAndToken = createUserAndToken; },
}));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: graphForUser }));
vi.mock("../services/teams/graphAppClient.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), graphAppFetch: graphAppMock, isAppGraphConfigured: () => true }));
vi.mock("../services/teams/autoRecord.js", () => ({ enableAutoRecording: autoRecordMock }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const SECRET = "test-secret-v888-teams";
const clientToken = (phone = "+17805550100") => jwt.sign({ role: "client", phone }, SECRET, { algorithm: "HS256" });

function meeting(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 10 * 60_000);
  return {
    id: MEETING_ID, subject: "Teams meeting with Sam Example", join_url: JOIN,
    scheduled_at: start.toISOString(), scheduled_end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
    organizer_user_id: STAFF_ID, staff_first_name: "Alex", client_name: "Sam Example", contact_name: "Sam Example",
    ...overrides,
  };
}

async function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/meetings", (await import("../routes/meetings.js")).default);
  return a;
}

let savedSecret: string | undefined;
let savedAcs: string | undefined;
beforeEach(() => {
  savedSecret = process.env.JWT_SECRET; savedAcs = process.env.ACS_CONNECTION_STRING;
  process.env.JWT_SECRET = SECRET;
  process.env.ACS_CONNECTION_STRING = "endpoint=https://acs-test.communication.azure.com/;accesskey=dGVzdA==";
  queryMock.mockReset();
  createUserAndToken.mockReset();
  createUserAndToken.mockResolvedValue({ token: "acs-token-1", expiresOn: new Date("2030-01-01T00:00:00Z"), user: { communicationUserId: "8:acs:test-user" } });
  graphForUser.mockReset();
  graphAppMock.mockReset();
  autoRecordMock.mockClear();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = savedSecret;
  if (savedAcs === undefined) delete process.env.ACS_CONNECTION_STRING; else process.env.ACS_CONNECTION_STRING = savedAcs;
});

describe("Teams links", () => {
  it("only real Teams meeting links can be joined", async () => {
    const { isTeamsJoinUrl, phone10 } = await import("../services/teams/inAppMeetings.js");
    expect(isTeamsJoinUrl(JOIN)).toBe(true);
    expect(isTeamsJoinUrl("https://teams.microsoft.com/meet/123456?p=abc")).toBe(true);
    expect(isTeamsJoinUrl("https://evil.example/l/meetup-join/x")).toBe(false);
    expect(isTeamsJoinUrl("http://teams.microsoft.com/l/meetup-join/x")).toBe(false);
    expect(phone10("+1 (780) 555-0100")).toBe("7805550100");
    expect(phone10("555")).toBe("");
  });
});

describe("clients join only meetings they are invited to", () => {
  it("an invited client gets a token, their name and the meeting's own Teams link", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM teams_meetings tm/, { rows: [meeting()] }]]));
    const r = await request(await app()).post("/api/meetings/acs-token").set("Authorization", "Bearer " + clientToken())
      .send({ meetingId: MEETING_ID, joinUrl: "https://teams.microsoft.com/l/meetup-join/someone-elses" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: "acs-token-1", acsUserId: "8:acs:test-user", displayName: "Sam Example", joinUrl: JOIN });
    const [sql, params] = queryMock.mock.calls.find(([s]) => String(s).includes("FROM teams_meetings tm"))!;
    expect(String(sql)).toContain("client_phone");
    expect(params).toEqual(["7805550100", MEETING_ID]);
    expect(createUserAndToken).toHaveBeenCalledWith(["voip"]);
  });

  it("a meeting that is not theirs is not found, and no token is made", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM teams_meetings tm/, { rows: [] }]]));
    const r = await request(await app()).post("/api/meetings/acs-token").set("Authorization", "Bearer " + clientToken()).send({ meetingId: MEETING_ID });
    expect(r.status).toBe(404);
    expect(createUserAndToken).not.toHaveBeenCalled();
  });

  it("a client cannot join days before the meeting", async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    queryMock.mockImplementation(answerBySql([[/FROM teams_meetings tm/, { rows: [meeting({ scheduled_at: start.toISOString(), scheduled_end_at: null })] }]]));
    const r = await request(await app()).post("/api/meetings/acs-token").set("Authorization", "Bearer " + clientToken()).send({ meetingId: MEETING_ID });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_open_yet");
  });

  it("a client must name a meeting", async () => {
    const r = await request(await app()).post("/api/meetings/acs-token").set("Authorization", "Bearer " + clientToken()).send({ joinUrl: JOIN });
    expect(r.status).toBe(400);
  });

  it("without ACS set up the app is told to open Teams instead, with the link", async () => {
    delete process.env.ACS_CONNECTION_STRING;
    queryMock.mockImplementation(answerBySql([[/FROM teams_meetings tm/, { rows: [meeting()] }]]));
    const r = await request(await app()).post("/api/meetings/acs-token").set("Authorization", "Bearer " + clientToken()).send({ meetingId: MEETING_ID });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "video_not_configured", joinUrl: JOIN });
  });

  it("lists the client's upcoming Teams meetings; other callers are refused", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM teams_meetings tm/, { rows: [meeting()] }]]));
    const a = await app();
    const r = await request(a).get("/api/meetings/upcoming").set("Authorization", "Bearer " + clientToken());
    expect(r.status).toBe(200);
    expect(r.body.inAppVideo).toBe(true);
    expect(r.body.timeZone).toBe("America/Regina");
    expect(r.body.meetings[0]).toMatchObject({ id: MEETING_ID, staffFirstName: "Alex", canJoinNow: true, joinUrl: JOIN });
    expect((await request(a).get("/api/meetings/upcoming")).status).toBe(401);
  });
});

describe("staff join meetings they organise or are invited to", () => {
  const staffRules = (found: unknown[]) => answerBySql([
    [/FROM users WHERE id/, { rows: [{ first_name: "Alex", last_name: "Tester", email: "alex@example.test", o365_user_email: null }] }],
    [/FROM teams_meetings tm/, { rows: found }],
  ]);

  it("their own meeting, found by its Teams link", async () => {
    queryMock.mockImplementation(staffRules([meeting()]));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe("Alex Tester (Boreal Financial)");
    const [sql, params] = queryMock.mock.calls.find(([s]) => String(s).includes("FROM teams_meetings tm"))!;
    expect(String(sql)).toContain("organizer_user_id = $1::uuid");
    expect(params).toEqual([STAFF_ID, "alex@example.test", JOIN]);
  });

  it("someone else's meeting is refused unless it is on their own calendar", async () => {
    queryMock.mockImplementation(staffRules([]));
    const a = await app();
    expect((await request(a).post("/api/meetings/acs-token").send({ joinUrl: JOIN })).status).toBe(404);

    graphForUser.mockResolvedValue({ fetch: async () => new Response(JSON.stringify({ subject: "Lender review", start: { dateTime: "2030-01-01T17:00:00" }, onlineMeeting: { joinUrl: JOIN } }), { status: 200 }) });
    const ok = await request(a).post("/api/meetings/acs-token").send({ joinUrl: JOIN, calendarEventId: "AAMk-test" });
    expect(ok.status).toBe(200);
    expect(ok.body.subject).toBe("Lender review");

    graphForUser.mockResolvedValue({ fetch: async () => new Response(JSON.stringify({ onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/other" } }), { status: 200 }) });
    expect((await request(a).post("/api/meetings/acs-token").send({ joinUrl: JOIN, calendarEventId: "AAMk-test" })).status).toBe(404);
  });

  it("a link that is not a Teams link is never looked up", async () => {
    queryMock.mockImplementation(staffRules([meeting()]));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: "https://example.test/meet" });
    expect(r.status).toBe(404);
    expect(queryMock.mock.calls.some(([s]) => String(s).includes("FROM teams_meetings tm"))).toBe(false);
  });
});

describe("Teams bookings from Book a call are registered for the poller and in-app joining", () => {
  async function bookAs(kind: "teams" | "phone") {
    const { candidateSlots, createBooking } = await import("../services/clientBooking.js");
    const staff = { id: STAFF_ID, email: "alex@example.test", first_name: "Alex", mailbox: "alex@example.test", signed_in: true };
    queryMock.mockImplementation(answerBySql([
      [/FROM users/, { rows: [staff] }],
      [/INSERT INTO contacts/, { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] }],
    ]));
    graphAppMock.mockImplementation(async (url: string, init: any) => {
      if (url.endsWith("/calendar/getSchedule")) return new Response(JSON.stringify({ value: [{ scheduleId: staff.mailbox, scheduleItems: [] }] }), { status: 200 });
      if (url.endsWith("/events")) {
        const ev = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: "ev-888", ...(ev.isOnlineMeeting ? { onlineMeeting: { joinUrl: JOIN } } : {}) }), { status: 201 });
      }
      return new Response("unexpected", { status: 599 });
    });
    return createBooking({ kind, startsAt: candidateSlots(new Date(), 14)[2]!, staffId: STAFF_ID, name: "Sam Example", email: "sam@example.test", phone: kind === "phone" ? "780-555-0100" : null, notes: null });
  }

  it("writes a teams_meetings row with the organiser's mailbox and turns on auto-record", async () => {
    const out = await bookAs("teams");
    expect(out.ok).toBe(true);
    const ins = queryMock.mock.calls.find(([s]) => String(s).includes("INSERT INTO teams_meetings"));
    expect(ins).toBeTruthy();
    expect(ins![1]).toEqual(expect.arrayContaining([STAFF_ID, "alex@example.test", "ev-888", JOIN]));
    expect(autoRecordMock).toHaveBeenCalledWith(expect.anything(), "ev-888", "alex@example.test", JOIN);
  });

  it("a phone booking is not registered as a Teams meeting", async () => {
    const out = await bookAs("phone");
    expect(out.ok).toBe(true);
    expect(queryMock.mock.calls.some(([s]) => String(s).includes("INSERT INTO teams_meetings"))).toBe(false);
    expect(autoRecordMock).not.toHaveBeenCalled();
  });
});
