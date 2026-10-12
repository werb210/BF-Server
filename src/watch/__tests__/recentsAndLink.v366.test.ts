// BF_SERVER_WATCH_RECENTS_SHAPE_v366 / BF_SERVER_WATCH_LINK_SLIDING_v366
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashWatchSecret, issueWatchAccessToken } from "../security.js";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));

const STAFF = "00000000-0000-4000-8000-0000000000a1";
const DEVICE = "dddddddd-0000-4000-8000-000000000001";
const SESSION = "eeeeeeee-0000-4000-8000-000000000001";
const ROWS = [
  { id: "c3", number: "+15874441234", contactName: "Jordan Lee", direction: "missed", occurredAt: "2026-10-11T18:00:05Z", cursorAt: new Date("2026-10-11T18:00:05.123Z"), line: "BF", status: "no-answer" },
  { id: "c2", number: "+15874441235", contactName: null, direction: "incoming", occurredAt: "2026-10-11T17:00:05Z", cursorAt: new Date("2026-10-11T17:00:05.456Z"), line: "BF", status: "completed" },
  { id: "c1", number: "+15874441236", contactName: null, direction: "outgoing", occurredAt: "2026-10-11T16:00:05Z", cursorAt: new Date("2026-10-11T16:00:05.789Z"), line: "BF", status: "completed" },
];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: SESSION, staff_user_id: STAFF, role: "Staff", silo: "BF", silos: ["BF"] }] }],
    [/FROM call_logs cl/, { rows: ROWS }],
    [/UPDATE watch_sessions s SET refresh_token_hash/, (_s: string, p?: unknown[]) => (p?.[0] === hashWatchSecret("good-refresh")
      ? { rows: [{ id: SESSION, device_id: DEVICE, staff_user_id: STAFF, expires_at: new Date() }] }
      : { rows: [] })],
  ]));
});

async function recents(query: string) {
  const data = (await import("../dataRoutes.js")).default;
  const app = express();
  app.use("/api/watch", data);
  return request(app).get(`/api/watch/calls/recent${query}`).set("Authorization", `Bearer ${issueWatchAccessToken(STAFF, DEVICE, SESSION).accessToken}`);
}
const recentSql = () => sqlText(callsMatching(queryMock, /FROM call_logs cl/)[0]![0]);

describe("Watch recent calls decode on the Watch", () => {
  it("sends the direction words the Watch understands", async () => {
    const res = await recents("?line=BF&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.direction)).toEqual(["missed", "incoming", "outgoing"]);
    const sql = recentSql();
    expect(sql).toContain("WHEN cl.direction = 'inbound' THEN 'incoming'");
    expect(sql).toContain("ELSE 'outgoing' END AS direction");
    expect(sql).toMatch(/IN \('no-answer','busy','failed','canceled','missed'\) THEN 'missed'/);
  });

  it("sends times without milliseconds and pages on the exact timestamp", async () => {
    const res = await recents("?line=BF&limit=2");
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].occurredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(recentSql()).toContain(`to_char(cl.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "occurredAt"`);
    // The cursor keeps the milliseconds the display time drops, so no call is skipped or repeated.
    expect(res.body.nextCursor).toBe("2026-10-11T17:00:05.456Z");
    queryMock.mockClear();
    await recents(`?line=BF&limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`);
    expect(callsMatching(queryMock, /FROM call_logs cl/)[0]![1]).toEqual([STAFF, "BF", "2026-10-11T17:00:05.456Z", 3]);
  });

  it("always sends a number and skips calls with none", async () => {
    await recents("?line=BF");
    const sql = recentSql();
    expect(sql).toContain("CASE WHEN cl.direction = 'inbound' THEN NULLIF(TRIM(cl.from_number), '')");
    expect(sql).toMatch(/COALESCE\(NULLIF\(TRIM\(cl\.phone_number\), ''\), NULLIF\(TRIM\(cl\.from_number\), ''\), NULLIF\(TRIM\(cl\.to_number\), ''\)\) IS NOT NULL/);
  });
});

describe("a Watch in use stays linked", () => {
  async function refresh(token: string) {
    const auth = (await import("../authRoutes.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/watch/auth", auth);
    return request(app).post("/api/watch/auth/refresh").send({ refreshToken: token });
  }

  it("every refresh extends the 30-day window", async () => {
    const res = await refresh("good-refresh");
    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe(DEVICE);
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe("good-refresh");
    const [rot] = callsMatching(queryMock, /UPDATE watch_sessions s SET refresh_token_hash/);
    expect(sqlText(rot![0])).toContain("refresh_expires_at=now()+interval '30 days'");
    expect(rot![1]).toEqual([hashWatchSecret("good-refresh"), hashWatchSecret(res.body.refreshToken)]);
    expect((await refresh("stale")).status).toBe(401);
  });
});
