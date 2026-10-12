// BF_SERVER_WATCH_SNAPSHOT_TASKS_v209
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, swallowed, nextMeetingFor } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  swallowed: [] as Array<{ where: string; fallback: unknown }>,
  nextMeetingFor: vi.fn(),
}));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../../lib/logWarnSwallowed.js", () => ({
  logWarnSwallowed: (_err: unknown, where: string, fallback: unknown) => { swallowed.push({ where, fallback }); return fallback; },
}));
vi.mock("../nextMeeting.js", () => ({ nextMeetingFor }));
vi.mock("../../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
}));

import { CALL_DISPOSITIONS, isCallDisposition } from "../../modules/calls/callDisposition.js";
import snapshotRouter, { buildWatchSnapshot } from "../snapshotRoutes.js";
import mayaStaff from "../../routes/mayaStaff.js";

const USER = "11111111-1111-4111-8111-111111111111";
const MISSED = /FROM call_events/;
const TASKS = /FROM tasks/;

// A call_logs table that only has staff_user_id, and a disposition catalogue without 'missed'.
const SCHEMA_ERRORS: Array<[RegExp, Error]> = [
  [/FROM call_logs[\s\S]*\buser_id = \$1/, new Error('column "user_id" does not exist')],
  [/disposition = 'missed'/, new Error("not a disposition")],
];

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  swallowed.length = 0;
  nextMeetingFor.mockReset();
  nextMeetingFor.mockResolvedValue({ title: "Standup", startsAt: "2026-10-12T15:00:00.000Z" });
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    ...SCHEMA_ERRORS,
    [/FROM staff_presence/, { rows: [{ status: "available", stale: false }] }],
    [MISSED, { rows: [{ count: "4" }] }],
    [TASKS, { rows: [{ count: "3" }] }],
  ]));
  fetchSpy = vi.fn(async () => { throw new Error("no network"); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the missed-call count that never worked", () => {
  it("no longer reads a column call_logs does not have", async () => {
    // migration 043 defines staff_user_id; there is no user_id on call_logs.
    const snap = await buildWatchSnapshot(USER);
    expect(snap.missedCalls).toBe(4);
    expect(callsMatching(queryMock, /FROM call_logs/)).toHaveLength(0);
    expect(swallowed).toEqual([]);
  });

  it("no longer matches a disposition that is not in the catalogue", async () => {
    expect(CALL_DISPOSITIONS as readonly string[]).not.toContain("missed");
    expect(isCallDisposition("missed")).toBe(false);
    await buildWatchSnapshot(USER);
    expect(callsMatching(queryMock, /disposition = 'missed'/)).toHaveLength(0);
  });

  it("uses the same source daily-briefing already uses correctly", async () => {
    await buildWatchSnapshot(USER);
    const [m] = callsMatching(queryMock, MISSED);
    expect(sqlText(m[0])).toContain("event_type = 'call.missed'");
    expect(m[1]).toEqual([USER]);

    const app = express();
    app.use(express.json());
    app.use("/api/maya", mayaStaff);
    queryMock.mockClear();
    const svc = jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).post("/api/maya/staff/daily-briefing").set("Authorization", "Bearer " + svc).send({ silo: "BF" });
    expect(r.status).toBe(200);
    expect(sqlText(callsMatching(queryMock, MISSED)[0][0])).toContain("event_type = 'call.missed'");
  });

  it("still counts from the start of today, not all time", async () => {
    await buildWatchSnapshot(USER);
    expect(sqlText(callsMatching(queryMock, MISSED)[0][0])).toMatch(/event_type = 'call\.missed'[\s\S]{0,120}date_trunc\('day', now\(\)\)/);
  });
});

describe("tasks due", () => {
  it("counts tasks assigned to the user", async () => {
    await buildWatchSnapshot(USER);
    const [t] = callsMatching(queryMock, TASKS);
    expect(sqlText(t[0])).toContain("assignee_user_id = $1::uuid");
    expect(t[1]).toEqual([USER]);
    expect(callsMatching(queryMock, /crm_tasks/)).toHaveLength(0);
  });

  it("includes overdue tasks, not just today's", async () => {
    // A count that silently drops a task once it is late is worse than none.
    await buildWatchSnapshot(USER);
    const sql = sqlText(callsMatching(queryMock, TASKS)[0][0]);
    expect(sql).toContain("due_at < date_trunc('day', now()) + interval '1 day'");
    expect(sql).not.toMatch(/due_at >= date_trunc\('day', now\(\)\)/);
  });

  it("excludes non-open task statuses", async () => {
    await buildWatchSnapshot(USER);
    const sql = sqlText(callsMatching(queryMock, TASKS)[0][0]);
    for (const done of ["COMPLETED", "DEFERRED"]) expect(sql).toContain(`'${done}'`);
  });

  it("ignores tasks with no due date", async () => {
    await buildWatchSnapshot(USER);
    expect(sqlText(callsMatching(queryMock, TASKS)[0][0])).toContain("due_at IS NOT NULL");
  });

  it("is returned to the watch", async () => {
    const snap = await buildWatchSnapshot(USER);
    expect(snap).toMatchObject({ status: "available", missedCalls: 4, tasksDue: 3, nextMeeting: { title: "Standup" } });
  });
});

describe("the snapshot cannot fail the watch", () => {
  it("every query degrades to a zero rather than throwing", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM staff_presence/, { rows: [{ status: "busy", stale: false }] }],
      [MISSED, new Error("call_events down")],
      [TASKS, new Error("tasks down")],
    ]));
    const snap = await buildWatchSnapshot(USER);
    expect(snap).toMatchObject({ status: "busy", missedCalls: 0, tasksDue: 0 });
    // BF_SERVER_SILENT_QUERIES_v678 - logged, same zero
    expect(swallowed.filter((s) => JSON.stringify(s.fallback) === JSON.stringify({ rows: [{ count: "0" }] }))).toHaveLength(2);
  });

  it("makes no Graph call - the watch must not wait on O365", async () => {
    const snap = await buildWatchSnapshot(USER);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nextMeetingFor).toHaveBeenCalledWith(USER);
    for (const c of queryMock.mock.calls) expect(sqlText(c[0])).not.toMatch(/graph|calendar\/events/i);
    nextMeetingFor.mockRejectedValue(new Error("graph down"));
    expect((await buildWatchSnapshot(USER)).nextMeeting).toBeNull();
    expect(snap.tasksDue).toBe(3);
  });

  it("is served on GET /snapshot to an authenticated user only", async () => {
    const app = express();
    app.use("/api/watch", snapshotRouter);
    expect((await request(app).get("/api/watch/snapshot")).status).toBe(401);
    const token = jwt.sign({ sub: USER, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).get("/api/watch/snapshot").set("Authorization", "Bearer " + token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ missedCalls: 4, tasksDue: 3 });
    expect(callsMatching(queryMock, TASKS).at(-1)?.[1]).toEqual([USER]);
  });
});
