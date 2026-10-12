// BF_SERVER_CLIENT_BOOKING_v738
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { albertaTime, candidateSlots, overlaps } from "../services/clientBooking.js";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock, graphMock } = vi.hoisted(() => ({ queryMock: vi.fn(), graphMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));
vi.mock("../services/teams/graphAppClient.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), graphAppFetch: graphMock, isAppGraphConfigured: () => true }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const TODD = { id: "11111111-1111-4111-8111-111111111111", email: "todd.w@boreal.financial", first_name: "Todd", mailbox: "todd.w@boreal.financial", signed_in: true };
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM users/, { rows: [TODD] }],
    [/INSERT INTO contacts/, { rows: [{ id: "c-new" }] }],
  ]));
  graphMock.mockReset();
  graphMock.mockImplementation(async (url: string, init: any) => {
    if (url.endsWith("/calendar/getSchedule")) return new Response(JSON.stringify({ value: [{ scheduleId: TODD.mailbox, scheduleItems: [] }] }), { status: 200 });
    if (url.endsWith("/events")) {
      const ev = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "ev-1", ...(ev.isOnlineMeeting ? { onlineMeeting: { joinUrl: "https://teams.test/join" } } : {}) }), { status: 201 });
    }
    return new Response("unexpected", { status: 599 });
  });
});
async function book(body: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use("/api/public/booking", (await import("../routes/clientBooking.js")).default);
  return request(a).post("/api/public/booking").send(body);
}
const slot = () => candidateSlots(new Date(), 14)[2]!.toISOString();
const graphEvent = () => JSON.parse(graphMock.mock.calls.find(([u]) => String(u).endsWith("/events"))![1].body);

describe("client booking", () => {
  it("converts Alberta wall-clock time to UTC across daylight saving", () => {
    expect(albertaTime(2026, 10, 6, 9).toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(albertaTime(2026, 12, 7, 9).toISOString()).toBe("2026-12-07T15:00:00.000Z"); // BF_SERVER_ALBERTA_TIME_v743 - no fall-back: UTC-6 all year
  });
  it("offers weekday 30-minute slots 9:00-17:00 Alberta time, at least 2 hours out", () => {
    const slots = candidateSlots(new Date("2026-10-06T15:00:00Z"), 7);
    expect(slots[0]!.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(slots.some((s) => s.toISOString() === "2026-10-06T22:30:00.000Z")).toBe(true);
    expect(slots.some((s) => s.toISOString() === "2026-10-06T23:00:00.000Z")).toBe(false);
    expect(slots.some((s) => s.toISOString().startsWith("2026-10-10"))).toBe(false);
  });
  it("a busy block removes the slots it overlaps", () => {
    const busy = [{ start: new Date("2026-10-06T17:15:00Z"), end: new Date("2026-10-06T17:45:00Z") }];
    expect(overlaps(new Date("2026-10-06T17:00:00Z"), busy)).toBe(true);
    expect(overlaps(new Date("2026-10-06T17:30:00Z"), busy)).toBe(true);
    expect(overlaps(new Date("2026-10-06T18:00:00Z"), busy)).toBe(false);
  });

  describe("clients can book phone calls and Teams meetings only, with a Teams link for Teams", () => {
    const client = { name: "Jordan Lee", email: "jordan@lee.test", phone: "780-444-1234", staffId: TODD.id };

    it("anything other than phone or teams is refused", async () => {
      for (const kind of ["video", "in_person", undefined]) {
        const r = await book({ ...client, kind, startsAt: slot() });
        expect(r.status, String(kind)).toBe(400);
        expect(r.body.error).toBe("kind_must_be_phone_or_teams");
      }
      expect(graphMock).not.toHaveBeenCalled();
    });

    it("a Teams booking asks Outlook for an online meeting and returns its join link", async () => {
      const r = await book({ ...client, kind: "teams", startsAt: slot() });
      expect(r.status).toBe(201);
      expect(r.body.booking).toMatchObject({ kind: "teams", joinUrl: "https://teams.test/join", staffFirstName: "Todd" });
      expect(graphEvent()).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" });
    });

    it("a phone booking is not an online meeting", async () => {
      const r = await book({ ...client, kind: "phone", startsAt: slot() });
      expect(r.status).toBe(201);
      expect(r.body.booking).toMatchObject({ kind: "phone", joinUrl: null });
      const ev = graphEvent();
      expect(ev.isOnlineMeeting).toBe(false);
      expect(ev).not.toHaveProperty("onlineMeetingProvider");
    });

    it("free/busy comes from the advisor's Outlook calendar", async () => {
      await book({ ...client, kind: "phone", startsAt: slot() });
      const [url, init] = graphMock.mock.calls.find(([u]) => String(u).endsWith("/calendar/getSchedule"))!;
      expect(url).toBe(`/users/${encodeURIComponent(TODD.mailbox)}/calendar/getSchedule`);
      expect(JSON.parse(init.body).schedules).toEqual([TODD.mailbox]);
    });
  });
});
