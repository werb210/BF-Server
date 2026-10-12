// BF_SERVER_ADS_WORKER_HEARTBEAT_v407
// BF_SERVER_NOTIFICATION_READ_IDEMPOTENT_v407
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
// The notifications service reads through lib/db's runQuery.
vi.mock("../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../lib/db.js")>("../lib/db");
  return { ...actual, runQuery: h.query };
});
vi.mock("../workers/claim.js", async (orig) => ({ ...(await orig<typeof import("../workers/claim.js")>()), claimedTick: (_name: string, fn: () => Promise<void>) => fn }));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<typeof import("../services/googleHealth.js")>()), startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));

const USER = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";

// A notifications table that answers the UPDATE the way Postgres would for the
// WHERE clause the service actually sends.
type Row = { id: string; user_id: string; is_read: boolean; read_at: string | null };
let table: Row[] = [];
function notificationsDb() {
  h.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = sqlText(sql);
    if (/UPDATE notifications/.test(text) && /WHERE id = \$1 AND user_id = \$2/.test(text)) {
      const unreadOnly = /is_read = false/.test(text);
      const hit = table.filter((r) => r.id === params[0] && r.user_id === params[1] && (!unreadOnly || !r.is_read));
      for (const r of hit) { r.is_read = true; r.read_at = r.read_at ?? "first-read"; }
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    if (/UPDATE notifications/.test(text) && /WHERE user_id = \$1/.test(text)) {
      const hit = table.filter((r) => r.user_id === params[0] && (!/is_read = false/.test(text) || !r.is_read));
      for (const r of hit) r.is_read = true;
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function app() {
  const router = (await import("../routes/notifications.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const a = express();
  a.use(express.json());
  a.use("/api/notifications", router);
  a.use(errorHandler);
  return a;
}
const token = (sub = USER) => jwt.sign({ sub, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

beforeEach(() => {
  h.query.mockReset();
  table = [{ id: "n1", user_id: USER, is_read: false, read_at: null }, { id: "n2", user_id: USER, is_read: false, read_at: null }];
  notificationsDb();
});

describe("v407 operational visibility", () => {
  it("the ad-conversion worker logs one line on every tick, even when nothing is configured", async () => {
    h.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    for (const k of Object.keys(process.env)) if (k.startsWith("GOOGLE_ADS_")) delete process.env[k];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
      const worker = startAdConversionWorker({} as any);
      await vi.waitFor(() => expect(log.mock.calls.some((c: unknown[]) => c[0] === "[ads_conversion] tick")).toBe(true));
      worker.stop();
      const ticks = log.mock.calls.filter((c: unknown[]) => c[0] === "[ads_conversion] tick");
      expect(ticks).toHaveLength(1);
      const line = JSON.parse(String(ticks[0]![1]));
      // the tick line carries every stage so an idle pass is still visible
      for (const key of ["submit", "qualified", "retracted", "funded", "attribution", "customerMatch"]) expect(line).toHaveProperty(key);
      expect(line.submit).toMatchObject({ configured: false });
      expect(line.funded).toMatchObject({ configured: false });
    } finally {
      log.mockRestore();
    }
  });

  it("marking a notification read twice is no longer an error, and keeps the first read time", async () => {
    const a = await app();
    const first = await request(a).post("/api/notifications/n1/read").set("Authorization", `Bearer ${token()}`);
    const second = await request(a).post("/api/notifications/n1/read").set("Authorization", `Bearer ${token()}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [sql] = callsMatching(h.query, /UPDATE notifications[\s\S]*WHERE id = \$1/)[0]!;
    expect(sqlText(sql)).toContain("read_at = COALESCE(read_at, now())");
  });

  it("an unknown notification id, or another user's, still answers 404", async () => {
    const a = await app();
    const unknown = await request(a).post("/api/notifications/nope/read").set("Authorization", `Bearer ${token()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe("Notification not found.");
    const notMine = await request(a).post("/api/notifications/n1/read").set("Authorization", `Bearer ${token(OTHER)}`);
    expect(notMine.status).toBe(404);
  });

  it("mark-all-read is untouched: only unread notifications are counted", async () => {
    table[0]!.is_read = true;
    const a = await app();
    const res = await request(a).post("/api/notifications/read-all").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const [sql] = callsMatching(h.query, /UPDATE notifications[\s\S]*WHERE user_id = \$1/)[0]!;
    expect(sqlText(sql)).toContain("WHERE user_id = $1 AND is_read = false");
  });
});
