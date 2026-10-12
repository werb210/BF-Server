// BF_SERVER_v789_O365_OAUTH_STATE - O365 connect state is a random single-use nonce
// held in an HttpOnly/Secure/SameSite=Lax cookie and stored (hashed) with the user
// and a 10-minute expiry; the callback needs the cookie, an unused unexpired nonce,
// and saves the tokens on the user who started the flow.
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateRow = { nonce_hash: string; user_id: string; expires_at: Date; consumed_at: Date | null };
const db = vi.hoisted(() => ({ states: [] as any[], updates: [] as Array<{ sql: string; params: any[] }>, currentUser: "user-a" }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: db.currentUser, role: "Staff" }; next(); },
}));
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO o365_oauth_states/i.test(sql)) {
        db.states.push({ nonce_hash: params[0], user_id: params[1], expires_at: params[2], consumed_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM o365_oauth_states/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE o365_oauth_states/i.test(sql)) {
        const row = (db.states as StateRow[]).find((r) => r.nonce_hash === params[0] && r.consumed_at === null && r.expires_at.getTime() > Date.now());
        if (!row) return { rows: [], rowCount: 0 };
        row.consumed_at = new Date();
        return { rows: [{ user_id: row.user_id }], rowCount: 1 };
      }
      if (/UPDATE users SET/i.test(sql)) { db.updates.push({ sql, params }); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }),
  },
  runQuery: vi.fn(),
}));

import o365OAuth from "../routes/o365OAuth.js";

const app = express();
app.use(express.json());
app.use("/api/o365-oauth", o365OAuth);

beforeEach(() => {
  db.states.length = 0;
  db.updates.length = 0;
  db.currentUser = "user-a";
  process.env.MSAL_TENANT_ID = "tenant-1";
  process.env.MSAL_CLIENT_ID = "client-1";
  process.env.MSAL_CLIENT_SECRET = "client-secret-1";
  process.env.O365_OAUTH_RETURN_URL = "https://staff.example/communications";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600 }), { status: 200 });
    if (url.includes("graph.microsoft.com/v1.0/me")) return new Response(JSON.stringify({ mail: "a@corp.example" }), { status: 200 });
    return new Response("unexpected", { status: 599 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function start(): Promise<{ state: string; cookie: string; setCookie: string }> {
  const r = await request(app).get("/api/o365-oauth/start");
  expect(r.status).toBe(200);
  const state = new URL(r.body.url).searchParams.get("state")!;
  const setCookie = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("o365_oauth_nonce="))!;
  return { state, setCookie, cookie: setCookie.split(";")[0]! };
}

const callback = (state: string, cookie?: string) => {
  const r = request(app).get(`/api/o365-oauth/callback?code=CODE&state=${encodeURIComponent(state)}`);
  return cookie ? r.set("Cookie", cookie) : r;
};

describe("/start", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax nonce cookie; the state is only that nonce", async () => {
    const { state, setCookie, cookie } = await start();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=600/i);
    expect(cookie).toBe(`o365_oauth_nonce=${state}`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url - no user id, no JWT
    expect(state.split(".")).toHaveLength(1);
  });

  it("stores only the nonce hash, with the user id and a 10-minute expiry", async () => {
    const before = Date.now();
    const { state } = await start();
    expect(db.states).toHaveLength(1);
    const row = db.states[0] as StateRow;
    expect(row.nonce_hash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(row.nonce_hash).not.toContain(state);
    expect(row.user_id).toBe("user-a");
    const ttl = row.expires_at.getTime() - before;
    expect(ttl).toBeGreaterThan(9.9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);
  });
});

describe("/callback", () => {
  it("connects the user who started the flow and clears the cookie", async () => {
    const { state, cookie } = await start();
    db.currentUser = "someone-else"; // the callback is public; identity comes from the stored nonce only
    const r = await callback(state, cookie);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("o365=connected");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.params).toEqual(["AT-1", "RT-1", expect.any(Date), "a@corp.example", "user-a"]);
    const cleared = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("o365_oauth_nonce="));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("refuses without the cookie (state alone is not enough)", async () => {
    const { state } = await start();
    const r = await callback(state);
    expect(r.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(0);
    expect((db.states[0] as StateRow).consumed_at).toBeNull();
  });

  it("refuses when the cookie belongs to a different flow (attacker's state, victim's browser)", async () => {
    const victim = await start();
    db.currentUser = "attacker";
    const attacker = await start();
    const r = await callback(attacker.state, victim.cookie);
    expect(r.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(0);
  });

  it("is single-use: a replay of the same state and cookie fails", async () => {
    const { state, cookie } = await start();
    expect((await callback(state, cookie)).headers.location).toContain("o365=connected");
    const again = await callback(state, cookie);
    expect(again.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(1);
  });

  it("refuses an expired nonce", async () => {
    const { state, cookie } = await start();
    (db.states[0] as StateRow).expires_at = new Date(Date.now() - 1000);
    const r = await callback(state, cookie);
    expect(r.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(0);
  });

  it("refuses an unknown nonce even when cookie and state match", async () => {
    const forged = "A".repeat(43);
    const r = await callback(forged, `o365_oauth_nonce=${forged}`);
    expect(r.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a legacy JWT state", async () => {
    const legacy = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1c2VyLWEifQ.sig";
    const r = await callback(legacy, `o365_oauth_nonce=${legacy}`);
    expect(r.headers.location).toContain("o365=error");
    expect(db.updates).toHaveLength(0);
  });
});
