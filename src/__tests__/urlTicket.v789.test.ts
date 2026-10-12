// BF_SERVER_v789_URL_TICKETS - routes that read a token from the query string
// accept only a 60-second URL ticket there; a full staff JWT in the URL is a 401.
// Media routes also take the normal Authorization header.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-url-ticket-v789";
const UID = "33333333-3333-4333-8333-333333333333";
const CONF = "abcdef12-3456";
const MSG = "44444444-4444-4444-8444-444444444444";

const { queryMock, users } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  users: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../db.js", () => {
  const pool = { query: queryMock, connect: vi.fn() };
  return { pool, db: pool, dbQuery: queryMock, query: queryMock, runQuery: queryMock, default: pool };
});

vi.mock("../voice/sseBus.js", () => ({
  subscribe: (_userId: string, res: any) => { res.status(200).json({ subscribed: _userId }); },
  subscriberCount: () => 0,
}));

function baseRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, email: "s@example.com", role: "Staff", silo: "BF", silos: ["BF"],
    active: true, is_active: true, disabled: false, status: "ACTIVE",
    deleted_at: null, locked_until: null, token_version: 0, ...over,
  };
}

// Answers by SQL content only.
async function answer(sql: string, params: unknown[] = []) {
  if (/FROM users WHERE id = \$1/.test(sql)) {
    const row = users.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  // No recording / message on file: an authenticated request reaches the handler and gets 404.
  return { rows: [], rowCount: 0 };
}

const staffJwt = (over: Record<string, unknown> = {}) =>
  jwt.sign({ sub: UID, role: "Staff", tokenVersion: 0, tv: 0, ...over }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const ticketSecret = () => `${SECRET}:bf-url-ticket`;

let app: express.Express;
let staffState: typeof import("../auth/staffUserState.js");
let urlTicket: typeof import("../auth/urlTicket.js");

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  staffState = await import("../auth/staffUserState.js");
  urlTicket = await import("../auth/urlTicket.js");
  const authRoutes = (await import("../routes/auth.js")).default;
  const communications = (await import("../routes/communications.js")).default;
  const realtime = (await import("../voice/realtimeRoutes.js")).default;
  const conversations = (await import("../routes/conversations.js")).default;
  app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/communications", communications);
  app.use("/api/realtime", realtime);
  app.use("/api", conversations);
});

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  staffState.resetStaffUserLoader();
  users.clear();
  users.set(UID, baseRow(UID));
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []));
});

async function issueTicket(): Promise<string> {
  const res = await request(app).post("/api/auth/url-ticket").set("Authorization", `Bearer ${staffJwt()}`);
  expect(res.status).toBe(200);
  return res.body.ticket as string;
}

const recording = `/api/communications/recordings/by-conference/${CONF}/media`;
const mms = `/api/communications/messages/${MSG}/media`;

describe("POST /api/auth/url-ticket", () => {
  it("issues a 60-second url_ticket for the caller", async () => {
    const ticket = await issueTicket();
    const claims = jwt.verify(ticket, ticketSecret(), { algorithms: ["HS256"], audience: "bf-url" }) as Record<string, unknown>;
    expect(claims.kind).toBe("url_ticket");
    expect(claims.sub).toBe(UID);
    expect(claims.aud).toBe("bf-url");
    expect(claims.tv).toBe(0);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);
  });

  it("requires staff auth", async () => {
    expect((await request(app).post("/api/auth/url-ticket")).status).toBe(401);
  });
});

describe("query-string tokens", () => {
  it("a ticket in the query is accepted on the media routes", async () => {
    const ticket = await issueTicket();
    expect((await request(app).get(`${recording}?token=${ticket}`)).status).toBe(404);
    expect((await request(app).get(`${mms}?token=${ticket}`)).status).toBe(404);
  });

  it("a full staff JWT in the query is a 401", async () => {
    const full = staffJwt();
    expect((await request(app).get(`${recording}?token=${full}`)).status).toBe(401);
    expect((await request(app).get(`${mms}?token=${full}`)).status).toBe(401);
    expect((await request(app).get(`/api/realtime/stream?token=${full}`)).status).toBe(401);
    expect((await request(app).get(`/api/communications/messages/stream?contactId=${MSG}&token=${full}`)).status).toBe(401);
    expect((await request(app).get(`/api/conversations/${MSG}/stream?token=${full}`)).status).toBe(401);
  });

  it("a full staff JWT in the query is a 401 even beside a valid header", async () => {
    const res = await request(app).get(`${recording}?token=${staffJwt()}`).set("Authorization", `Bearer ${staffJwt()}`);
    expect(res.status).toBe(401);
  });

  it("an expired ticket is a 401", async () => {
    const expired = jwt.sign(
      { kind: "url_ticket", tv: 0, exp: Math.floor(Date.now() / 1000) - 5 },
      ticketSecret(),
      { algorithm: "HS256", subject: UID, audience: "bf-url" },
    );
    expect((await request(app).get(`${recording}?token=${expired}`)).status).toBe(401);
    expect((await request(app).get(`/api/realtime/stream?token=${expired}`)).status).toBe(401);
  });

  it("a ticket for a disabled user or with a stale tv is a 401", async () => {
    const ticket = await issueTicket();
    users.set(UID, baseRow(UID, { disabled: true }));
    staffState.clearStaffUserCache(UID);
    expect((await request(app).get(`${recording}?token=${ticket}`)).status).toBe(401);
    users.set(UID, baseRow(UID, { token_version: 1 }));
    staffState.clearStaffUserCache(UID);
    expect((await request(app).get(`${recording}?token=${ticket}`)).status).toBe(401);
  });

  it("the realtime stream accepts a ticket", async () => {
    const ticket = await issueTicket();
    const res = await request(app).get(`/api/realtime/stream?token=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.body.subscribed).toBe(UID);
  });

  it("a ticket is not a bearer token for normal routes", async () => {
    const ticket = await issueTicket();
    expect((await request(app).get("/api/conversations").set("Authorization", `Bearer ${ticket}`)).status).toBe(401);
    expect((await request(app).get(`${recording}`).set("Authorization", `Bearer ${ticket}`)).status).toBe(401);
  });

  it("the team websocket check refuses a full JWT and accepts a ticket", async () => {
    expect((await urlTicket.authenticateUrlTicket(staffJwt())).ok).toBe(false);
    const ok = await urlTicket.authenticateUrlTicket(await issueTicket());
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.user.userId).toBe(UID);
  });
});

describe("Authorization header on media routes", () => {
  it("still works without a query token", async () => {
    expect((await request(app).get(recording).set("Authorization", `Bearer ${staffJwt()}`)).status).toBe(404);
    expect((await request(app).get(mms).set("Authorization", `Bearer ${staffJwt()}`)).status).toBe(404);
    expect((await request(app).get(`/api/realtime/stream`).set("Authorization", `Bearer ${staffJwt()}`)).status).toBe(200);
  });

  it("no token at all is a 401", async () => {
    expect((await request(app).get(recording)).status).toBe(401);
  });
});
