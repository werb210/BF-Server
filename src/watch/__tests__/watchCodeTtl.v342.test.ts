// BF_SERVER_WATCH_CODE_TTL_v342
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { hashWatchSecret } from "../security.js";
import { answerBySql, callsMatching, sqlText, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, clientQuery } = vi.hoisted(() => ({ queryMock: vi.fn(), clientQuery: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pool: { query: queryMock, connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })) },
}));

const STAFF = "00000000-0000-4000-8000-0000000000a1";
const staffTok = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const clientTok = () => jwt.sign({ sub: "client:+17805550100", role: "client", isClient: true, phone: "+17805550100" }, String(process.env.JWT_SECRET));
const DEVICE = { platform: "watchos", name: "Todd's Watch" };

async function app() {
  const router = (await import("../authRoutes.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/watch/auth", router);
  return a;
}
function linkDb(rules: SqlRule[]) {
  clientQuery.mockImplementation(answerBySql([
    ...rules,
    [/INSERT INTO watch_devices/, { rows: [{ id: "dev-1" }] }],
  ], { rows: [], rowCount: 1 }));
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  clientQuery.mockReset();
  linkDb([]);
});

describe("an enrollment code outlives its delivery window", () => {
  it("lasts a day, not five minutes", async () => {
    // The durable WCSession application context can be delivered hours after the
    // phone sends it - that is the point of it - so a five-minute code arrived
    // dead and the Watch could never link on that path.
    const before = Date.now();
    const res = await request(await app()).post("/api/watch/auth/enrollment").set("Authorization", `Bearer ${staffTok()}`);
    expect(res.status).toBe(201);
    const ttl = Date.parse(res.body.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60_000 + 5000);
    const [ins] = callsMatching(queryMock, /INSERT INTO watch_link_codes/);
    expect((ins![1] as unknown[])[2]).toEqual(new Date(res.body.expiresAt));
  });

  it("is still single-use, which is what actually bounds the risk", async () => {
    const code = "12345678";
    linkDb([[/UPDATE watch_link_codes SET used_at=now\(\)/, { rows: [{ staff_user_id: STAFF }] }]]);
    const ok = await request(await app()).post("/api/watch/auth/link").send({ oneTimeCode: code, device: DEVICE });
    expect(ok.status).toBe(201);
    expect(ok.body.deviceId).toBe("dev-1");
    const [consume] = callsMatching(clientQuery, /UPDATE watch_link_codes/);
    expect(sqlText(consume![0])).toContain("SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()");
    expect(consume![1]).toEqual([hashWatchSecret(code)]);

    // The same code again: the consuming UPDATE matches nothing and the code is known as used.
    clientQuery.mockClear();
    linkDb([[/SELECT expires_at,used_at FROM watch_link_codes/, { rows: [{ expires_at: new Date(Date.now() + 3600_000), used_at: new Date() }] }]]);
    const again = await request(await app()).post("/api/watch/auth/link").send({ oneTimeCode: code, device: DEVICE });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("unauthenticated");
    expect(callsMatching(clientQuery, /INSERT INTO watch_sessions/)).toHaveLength(0);
  });

  it("is still stored only as a hash", async () => {
    const res = await request(await app()).post("/api/watch/auth/enrollment").set("Authorization", `Bearer ${staffTok()}`);
    const code = res.body.oneTimeCode as string;
    expect(code).toMatch(/^\d{8}$/);
    const [ins] = callsMatching(queryMock, /INSERT INTO watch_link_codes/);
    expect((ins![1] as unknown[]).slice(0, 2)).toEqual([STAFF, hashWatchSecret(code)]);
    expect(JSON.stringify(ins![1])).not.toContain(code);
  });

  it("still needs a staff token to mint and refuses a client one", async () => {
    expect((await request(await app()).post("/api/watch/auth/enrollment")).status).toBe(401);
    const client = await request(await app()).post("/api/watch/auth/enrollment").set("Authorization", `Bearer ${clientTok()}`);
    expect(client.status).toBe(403);
    expect(callsMatching(queryMock, /INSERT INTO watch_link_codes/)).toHaveLength(0);
  });

  it("still rate limits the link route", async () => {
    const a = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await request(a).post("/api/watch/auth/link").send({ oneTimeCode: "bad", device: DEVICE })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("still tells an expired code apart from an invalid one", async () => {
    linkDb([[/SELECT expires_at,used_at FROM watch_link_codes/, { rows: [{ expires_at: new Date(Date.now() - 1000), used_at: null }] }]]);
    const expired = await request(await app()).post("/api/watch/auth/link").send({ oneTimeCode: "87654321", device: DEVICE });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("expired_code");

    linkDb([]);
    const unknown = await request(await app()).post("/api/watch/auth/link").send({ oneTimeCode: "87654321", device: DEVICE });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("unauthenticated");
  });
});
