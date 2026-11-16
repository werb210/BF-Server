// BF_SERVER_v962_TEAMS_NO_LOBBY + BF_SERVER_v962_CALENDAR_TEAMS
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_v962%40thread.v2/0";

const { queryMock, graphForUser, graphAppMock } = vi.hoisted(() => ({ queryMock: vi.fn(), graphForUser: vi.fn(), graphAppMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { userId: STAFF_ID, role: "Staff" }; next(); },
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/silo.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getSilo: () => "BF" }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: graphForUser }));
vi.mock("../services/teams/graphAppClient.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), graphAppFetch: graphAppMock, isAppGraphConfigured: () => true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function appGraph(patches: Array<Record<string, unknown>>, opts: { meetingFound?: boolean } = {}) {
  graphAppMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return json({}); }
    if (path.includes("/onlineMeetings?")) return json({ value: opts.meetingFound === false ? [] : [{ id: "MSo-meeting-1" }] });
    if (path.startsWith("/users/")) return json({ id: "aad-user-1" });
    return json({}, 404);
  });
}

beforeEach(() => { queryMock.mockReset(); graphForUser.mockReset(); graphAppMock.mockReset(); });

describe("nobody is held in the Teams lobby", () => {
  it("a new meeting is set to record and to let everyone straight in", async () => {
    const patches: Array<Record<string, unknown>> = [];
    appGraph(patches);
    queryMock.mockImplementation(answerBySql([[/UPDATE teams_meetings/, { rows: [], rowCount: 1 }]]));
    const { enableAutoRecording } = await import("../services/teams/autoRecord.js");
    await enableAutoRecording({ query: queryMock } as any, "event-1", "Alex@Boreal.example", JOIN);
    expect(patches).toEqual([{ recordAutomatically: true }, { lobbyBypassSettings: { scope: "everyone", isDialInBypassEnabled: true } }]);
  });

  it("joining a meeting you organise opens its lobby; someone else's meeting is left alone", async () => {
    const { openLobbyForOrganizer } = await import("../services/teams/autoRecord.js");
    const patches: Array<Record<string, unknown>> = [];
    appGraph(patches);
    expect(await openLobbyForOrganizer("alex@boreal.example", JOIN + "a")).toBe(true);
    expect(patches).toEqual([{ lobbyBypassSettings: { scope: "everyone", isDialInBypassEnabled: true } }]);
    const calls = graphAppMock.mock.calls.length;
    expect(await openLobbyForOrganizer("alex@boreal.example", JOIN + "a")).toBe(true); // already done, no second round
    expect(graphAppMock.mock.calls.length).toBe(calls);

    const none: Array<Record<string, unknown>> = [];
    appGraph(none, { meetingFound: false });
    expect(await openLobbyForOrganizer("alex@boreal.example", JOIN + "b")).toBe(false);
    expect(none).toEqual([]);
    expect(await openLobbyForOrganizer("", JOIN)).toBe(false);
  });
});

describe("the calendar can make an event a Teams meeting", () => {
  async function app() {
    const a = express();
    a.use(express.json());
    a.use("/api/calendar", (await import("../routes/calendar.js")).default);
    return a;
  }
  function userGraph(sent: Array<Record<string, unknown>>) {
    graphForUser.mockResolvedValue({
      fetch: async (path: string, init?: RequestInit) => {
        if (path === "/me/events") {
          const b = JSON.parse(String(init?.body)); sent.push(b);
          return json({ id: "event-9", subject: b.subject, start: b.start, end: b.end, onlineMeeting: b.isOnlineMeeting ? { joinUrl: JOIN } : null });
        }
        if (path.startsWith("/me?")) return json({ userPrincipalName: "alex@boreal.example" });
        return json({}, 404);
      },
    });
  }

  it("Teams meeting: the event is created online, registered, and comes back with its link", async () => {
    const sent: Array<Record<string, unknown>> = [];
    userGraph(sent);
    appGraph([]);
    queryMock.mockImplementation(answerBySql([[/INSERT INTO teams_meetings/, { rows: [], rowCount: 1 }], [/UPDATE teams_meetings/, { rows: [], rowCount: 1 }], [/FROM contacts/, { rows: [] }]]));
    const r = await request(await app()).post("/api/calendar/events")
      .send({ title: "Roll-out call", start: "2030-01-05T17:00:00.000Z", end: "2030-01-05T17:30:00.000Z", attendees: "sam@example.com", meetingType: "teams" });
    expect(r.status).toBe(201);
    expect(sent[0]).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", attendees: [{ emailAddress: { address: "sam@example.com" } }] });
    expect(r.body.data.teamsLink).toBe(JOIN);
    const reg = queryMock.mock.calls.find(([s]) => /INSERT INTO teams_meetings/.test(String(s)))!;
    expect(reg[1]).toEqual(["BF", STAFF_ID, "alex@boreal.example", "Roll-out call", "event-9", JOIN, "2030-01-05T17:00:00.000Z", "2030-01-05T17:30:00.000Z"]);
  });

  it("an ordinary event is not turned into a Teams meeting", async () => {
    const sent: Array<Record<string, unknown>> = [];
    userGraph(sent);
    queryMock.mockImplementation(answerBySql([[/FROM contacts/, { rows: [] }]]));
    const r = await request(await app()).post("/api/calendar/events").send({ title: "Lunch", start: "2030-01-05T17:00:00.000Z", end: "2030-01-05T18:00:00.000Z" });
    expect(r.status).toBe(201);
    expect(sent[0]).not.toHaveProperty("isOnlineMeeting");
    expect(queryMock.mock.calls.some(([s]) => /teams_meetings/.test(String(s)))).toBe(false);
  });
});
