// BF_SERVER_v784_CLIENT_OWNERSHIP - any client route naming an existing
// application (query, body or path) needs a valid token: the owning client (or
// anyone while the application is unclaimed), staff or service.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-client-ownership-v784";
const OWNED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNCLAIMED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOT_AN_APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_PHONE = "+15875550123";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db.js", () => {
  const pool = { query: queryMock, connect: vi.fn() };
  return { pool, db: pool, dbQuery: queryMock, query: queryMock, runQuery: queryMock, default: pool };
});

function answer(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM applications WHERE id::text = ANY($1::text[])")) {
    const ids = (params[0] as string[]) ?? [];
    return { rows: ids.filter((id) => id === OWNED || id === UNCLAIMED).map((id) => ({ id })) };
  }
  if (sql.includes("WITH app_phones AS")) {
    const id = params[0];
    if (id === OWNED) return { rows: [{ total: 1, mine: params[1] === OWNER_PHONE.slice(-10) ? 1 : 0, known: 1 }] };
    if (id === UNCLAIMED) return { rows: [{ total: 1, mine: 0, known: 0 }] };
    return { rows: [{ total: 0, mine: 0, known: 0 }] };
  }
  return { rows: [] };
}

const sign = (claims: Record<string, unknown>) => jwt.sign(claims, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const client = (phone = OWNER_PHONE) => sign({ sub: `client:${phone}`, role: "client", phone, isClient: true });
const staff = () => sign({ sub: "11111111-1111-1111-1111-111111111111", role: "Admin" });
const service = () => sign({ kind: "service", service: "agent", principal: "service", id: "agent-service", role: "Staff" });

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  const { clientApplicationOwnershipGuard } = await import("../auth/clientApplicationOwnership.js");
  app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(clientApplicationOwnershipGuard);
  router.get("/application/:id/status", (_req, res) => { res.json({ ok: true }); });
  router.patch("/applications/:id", (_req, res) => { res.json({ ok: true }); });
  router.get("/messages", (_req, res) => { res.json({ ok: true }); });
  router.get("/continuation/:token", (_req, res) => { res.json({ ok: true }); });
  app.use("/api/client", router);
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []));
});

describe("client application ownership guard", () => {
  it("token-less request naming an existing application -> 401 (path, body, query)", async () => {
    expect((await request(app).get(`/api/client/application/${OWNED}/status`)).status).toBe(401);
    expect((await request(app).patch(`/api/client/applications/${OWNED}`).send({})).status).toBe(401);
    expect((await request(app).get(`/api/client/messages?applicationId=${OWNED}`)).status).toBe(401);
  });

  it("owner passes, another client is 403", async () => {
    expect((await request(app).get(`/api/client/application/${OWNED}/status`).set("Authorization", `Bearer ${client()}`)).status).toBe(200);
    expect((await request(app).get(`/api/client/application/${OWNED}/status`).set("Authorization", `Bearer ${client("+15875550199")}`)).status).toBe(403);
    expect((await request(app).patch(`/api/client/applications/${OWNED}`).set("Authorization", `Bearer ${client("+15875550199")}`).send({})).status).toBe(403);
  });

  it("an unclaimed (mid-wizard) application passes for any client token", async () => {
    expect((await request(app).patch(`/api/client/applications/${UNCLAIMED}`).set("Authorization", `Bearer ${client("+15875550199")}`).send({})).status).toBe(200);
  });

  it("staff and service pass", async () => {
    for (const t of [staff(), service()]) {
      expect((await request(app).get(`/api/client/messages?applicationId=${OWNED}`).set("Authorization", `Bearer ${t}`)).status).toBe(200);
    }
  });

  it("tracked-link token -> 401, lender token -> 403", async () => {
    expect((await request(app).get(`/api/client/application/${OWNED}/status`).set("Authorization", `Bearer ${sign({ sid: "s", u: "x" })}`)).status).toBe(401);
    expect((await request(app).get(`/api/client/application/${OWNED}/status`).set("Authorization", `Bearer ${sign({ sub: "lender:1", role: "Lender" })}`)).status).toBe(403);
  });

  it("ids that are not applications are left alone", async () => {
    expect((await request(app).get(`/api/client/continuation/${NOT_AN_APP}`)).status).toBe(200);
    expect((await request(app).get(`/api/client/continuation/some-opaque-token`)).status).toBe(200);
  });
});
