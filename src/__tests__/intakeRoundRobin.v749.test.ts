// BF_SERVER_BOOKING_MAILBOX_v749 / BF_SERVER_CLIENT_FAILURE_LOG_v749
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
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

import { intakeTeam, mailboxOf, bookableStaff, openSlots, createBooking, type Staff } from "../services/clientBooking.js";
import { isClientFailure, recordClientFailure, recentClientFailures, clearClientFailures, clientFailureLog } from "../middleware/clientFailureLog.js";
import { createApp } from "../app.js";

const todd: Staff = { id: "t", email: "todd.w@boreal.financial", first_name: "Todd", signed_in: true, mailbox: "todd.w@boreal.financial" };
const andrew: Staff = { id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" };
const sam = { id: "s", email: "sam@boreal.financial", first_name: "Sam", signed_in: true, mailbox: "sam.k@boreal.financial" };

beforeEach(() => {
  q.mockReset();
  q.mockImplementation(answerBySql([]));
  graph.fetch.mockReset();
});

describe("booking mailbox (BF_SERVER_BOOKING_MAILBOX_v749)", () => {
  afterEach(() => { delete process.env.BOOKING_INTAKE_EXCLUDE; });
  it("Andrew is out of the intake team whether he logs in as andrew@ or andrew.p@", () => {
    expect(intakeTeam([todd, andrew]).map((s) => s.id)).toEqual(["t"]);
    expect(intakeTeam([todd, { ...andrew, email: "andrew.p@boreal.financial" }]).map((s) => s.id)).toEqual(["t"]);
    process.env.BOOKING_INTAKE_EXCLUDE = "andrew.p@boreal.financial";
    expect(intakeTeam([todd, andrew]).map((s) => s.id)).toEqual(["t"]);
  });

  it("the calendar is the Office 365 mailbox, falling back to the login email", async () => {
    expect(mailboxOf(andrew)).toBe("andrew.p@boreal.financial");
    expect(mailboxOf({ id: "x", email: "Sam@boreal.financial", first_name: null })).toBe("sam@boreal.financial");
    q.mockImplementation(async (sql: string) => (/FROM users/.test(String(sql)) && /o365_user_email/.test(String(sql))
      ? { rows: [{ id: "a", email: "andrew@boreal.financial", first_name: "Andrew", signed_in: true, mailbox: "andrew.p@boreal.financial" }] }
      : { rows: [] }));
    expect(mailboxOf((await bookableStaff())[0]!)).toBe("andrew.p@boreal.financial");
  });

  it("free/busy is read for each person's mailbox, and their busy time is keyed by it", async () => {
    q.mockImplementation(answerBySql([[/FROM users/, { rows: [sam] }]]));
    const now = new Date("2026-10-13T14:00:00Z");
    let busyStart = "";
    graph.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/calendar/getSchedule")) {
        const body = JSON.parse(String(init?.body));
        busyStart = String(body.startTime.dateTime);
        return new Response(JSON.stringify({ value: [{ scheduleId: "Sam.K@boreal.financial", scheduleItems: [{ status: "busy", start: { dateTime: busyStart }, end: { dateTime: busyStart.slice(0, 11) + "23:59:00" } }] }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const slots = await openSlots(now, null, 3);
    const call = graph.fetch.mock.calls.find((c) => String(c[0]).endsWith("/calendar/getSchedule"))!;
    expect(call[0]).toBe("/users/" + encodeURIComponent("sam.k@boreal.financial") + "/calendar/getSchedule");
    expect(JSON.parse(String((call[1] as RequestInit).body)).schedules).toEqual(["sam.k@boreal.financial"]);
    // The busy block is applied to Sam's slots: nothing is offered on the busy day.
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.startsAt.slice(0, 10) === busyStart.slice(0, 10))).toBe(false);
  });

  it("the Outlook event is created on the person's mailbox", async () => {
    q.mockImplementation(answerBySql([
      [/FROM users/, { rows: [sam] }],
      [/INSERT INTO contacts/, { rows: [{ id: "c-new" }] }],
    ]));
    graph.fetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/calendar/getSchedule")) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      if (path.endsWith("/events")) return new Response(JSON.stringify({ id: "ev-1" }), { status: 201 });
      return new Response("{}", { status: 200 });
    });
    const now = new Date("2026-10-13T14:00:00Z");
    const [first] = await openSlots(now, null, 3);
    const out = await createBooking({ kind: "phone", startsAt: new Date(first!.startsAt), staffId: null, name: "Dana", email: "dana@x.example", phone: "4035550100", notes: null, now });
    expect(out.ok).toBe(true);
    const events = graph.fetch.mock.calls.filter((c) => String(c[0]).endsWith("/events"));
    expect(events.map((c) => c[0])).toEqual(["/users/" + encodeURIComponent("sam.k@boreal.financial") + "/events"]);
  });
});

describe("client failure log", () => {
  beforeEach(() => { clearClientFailures(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("counts 401, 403 and 5xx and keeps the newest 200", () => {
    expect([200, 400, 401, 403, 404, 500, 503].filter(isClientFailure)).toEqual([401, 403, 500, 503]);
    for (let i = 0; i < 205; i += 1) recordClientFailure({ at: String(i), method: "GET", path: "/x", status: 500, ms: 1, hadAuth: true, appVersion: null, instance: null, uptimeS: 1 });
    expect(recentClientFailures().length).toBe(200);
    expect(recentClientFailures()[0]!.at).toBe("204");
  });

  it("logs the path without the query string, nothing for a success", () => {
    const h: Record<string, () => void> = {};
    const req: any = { method: "GET", originalUrl: "/api/client/action-center?applicationId=abc&token=secret", headers: {} };
    clientFailureLog(req, { statusCode: 403, on: (e: string, f: () => void) => { h[e] = f; } } as any, () => undefined);
    h.finish!();
    clientFailureLog(req, { statusCode: 200, on: (e: string, f: () => void) => { h[e] = f; } } as any, () => undefined);
    h.finish!();
    expect(recentClientFailures().map((f) => f.path)).toEqual(["/api/client/action-center"]);
  });

  describe("in the app", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = createApp();
    const admin = "Bearer " + jwt.sign({ sub: "22222222-2222-4222-8222-222222222222", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    it("is mounted on /api/client and readable by an admin", async () => {
      // The suite resets the module registry after every test, and the admin route loads the log
      // lazily: build this app from the current registry so the route and the middleware share one log.
      const { createApp: freshApp } = await import("../app.js");
      const { recentClientFailures, clearClientFailures } = await import("../middleware/clientFailureLog.js");
      clearClientFailures();
      const app = freshApp();
      const failed = await request(app).get(`/api/client/applications/${APP}/form-responses?token=secret`).set("X-App-Version", "2026.10.1");
      expect(failed.status).toBe(401);
      const logged = recentClientFailures();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ method: "GET", path: `/api/client/applications/${APP}/form-responses`, status: 401, hadAuth: false, appVersion: "2026.10.1" });

      // Other API traffic is not recorded.
      await request(app).get("/api/admin/client-failures");
      expect(recentClientFailures()).toHaveLength(1);

      const r = await request(app).get("/api/admin/client-failures").set("Authorization", admin);
      expect(r.status).toBe(200);
      expect(r.body.failures).toEqual([expect.objectContaining({ path: `/api/client/applications/${APP}/form-responses`, status: 401 })]);
      expect(typeof r.body.startedAt).toBe("string");
    }, 60_000);

    it("the SMS redirect falls back to www", async () => {
      const bad = await request(app).get("/api/r/not-a-token");
      expect(bad.status).toBe(302);
      expect(bad.headers.location).toBe("https://www.boreal.financial");
      const noUrl = jwt.sign({ u: "javascript:alert(1)" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
      const r = await request(app).get("/api/r/" + noUrl);
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe("https://www.boreal.financial");
      const good = jwt.sign({ u: "https://client.boreal.financial/x" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
      expect((await request(app).get("/api/r/" + good)).headers.location).toBe("https://client.boreal.financial/x");
    });
  });
});
