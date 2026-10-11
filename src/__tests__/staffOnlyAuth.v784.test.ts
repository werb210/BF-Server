// BF_SERVER_v784_STAFF_ONLY_AUTH - the staff middlewares admit staff humans and
// service principals only; client-app routes opt in by name and check ownership.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-staff-only-v784";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_PHONE = "+15875550123";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db.js", () => {
  const pool = { query: queryMock, connect: vi.fn() };
  return { pool, db: pool, dbQuery: queryMock, query: queryMock, runQuery: queryMock, default: pool };
});

function answer(sql: string, params: unknown[] = []) {
  if (/FROM users WHERE id = \$1/.test(sql)) {
    return { rows: [{ id: params[0], email: "staff@example.com", role: "Staff", silo: "BF", silos: ["BF"] }] };
  }
  if (sql.includes("WITH app_phones AS")) {
    const exists = params[0] === APP_ID;
    const mine = exists && params[1] === OWNER_PHONE.slice(-10) ? 1 : 0;
    return { rows: [{ total: exists ? 1 : 0, mine, known: exists ? 1 : 0 }] };
  }
  if (sql.includes("FROM qa_sets") && sql.includes("status IN ('sent', 'answered')")) return { rows: [] };
  return { rows: [] };
}

const sign = (claims: Record<string, unknown>) => jwt.sign(claims, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const staff = () => sign({ sub: "11111111-1111-1111-1111-111111111111", role: "Staff" });
const client = (phone = OWNER_PHONE) => sign({ sub: `client:${phone}`, role: "client", phone, isClient: true });
const trackedLink = () => sign({ sid: "send-1", u: "https://boreal.financial" });
const agentService = () => sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" });
const legacyAgent = () => sign({ id: "agent-service", role: "Staff" });

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  const authMw = await import("../middleware/auth.js");
  const requireAuthMw = await import("../middleware/requireAuth.js");
  const lenderQa = (await import("../routes/lenderQa.js")).default;
  const messages = (await import("../routes/messages.js")).default;
  app = express();
  app.use(express.json());
  // Stand-ins for staff surfaces (/api/companies, /api/tasks ...) using the real middlewares.
  app.get("/api/companies", authMw.requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.get("/api/tasks", requireAuthMw.requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.get("/api/auth/me", requireAuthMw.requireAuthAllowClient, (req: any, res) => { res.json({ role: req.user?.role ?? null }); });
  app.post("/api/push/register-token", authMw.requireAuthAllowClient, (req: any, res) => { res.json({ user: req.user?.userId }); });
  app.use("/api/portal", lenderQa);
  app.use("/api/messages", messages);
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []));
});

describe("staff-only middleware (middleware/auth.ts)", () => {
  it("staff token -> 200", async () => {
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${staff()}`);
    expect(res.status).toBe(200);
  });
  it("client OTP token -> 403", async () => {
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${client()}`);
    expect(res.status).toBe(403);
  });
  it("SMS tracked-link token -> 401", async () => {
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${trackedLink()}`);
    expect(res.status).toBe(401);
  });
  it.each([
    ["lender", { sub: "lender:1", role: "Lender" }],
    ["referrer", { sub: "referrer:1", role: "Referrer" }],
    ["accountant", { sub: "accountant:1", role: "accountant", isAccountant: true }],
    ["applicant", { kind: "applicant", sub: "bi-app-1" }],
  ])("%s token -> 403", async (_name, claims) => {
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${sign(claims)}`);
    expect(res.status).toBe(403);
  });
  it("no-role token -> 401", async () => {
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${sign({ id: "x" })}`);
    expect(res.status).toBe(401);
  });
  it("agent service token and legacy agent token pass", async () => {
    for (const t of [agentService(), legacyAgent()]) {
      const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${t}`);
      expect(res.status).toBe(200);
    }
  });
  it("rejects a token signed with another algorithm", async () => {
    const t = jwt.sign({ sub: "u1", role: "Staff" }, SECRET, { algorithm: "HS512" });
    const res = await request(app).get("/api/companies").set("Authorization", `Bearer ${t}`);
    expect(res.status).toBe(401);
  });
});

describe("staff-only middleware (middleware/requireAuth.ts)", () => {
  it("client 403, tracked-link 401, no-role 401, staff and services 200", async () => {
    expect((await request(app).get("/api/tasks").set("Authorization", `Bearer ${client()}`)).status).toBe(403);
    expect((await request(app).get("/api/tasks").set("Authorization", `Bearer ${trackedLink()}`)).status).toBe(401);
    expect((await request(app).get("/api/tasks").set("Authorization", `Bearer ${sign({ sub: "x" })}`)).status).toBe(401);
    for (const t of [staff(), agentService(), legacyAgent()]) {
      expect((await request(app).get("/api/tasks").set("Authorization", `Bearer ${t}`)).status).toBe(200);
    }
  });
});

describe("client tokens still work on their own routes", () => {
  it("/api/auth/me accepts a client token", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${client()}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("client");
  });
  it("push token registration accepts a client token but not a tracked link", async () => {
    expect((await request(app).post("/api/push/register-token").set("Authorization", `Bearer ${client()}`).send({ token: "t" })).status).toBe(200);
    expect((await request(app).post("/api/push/register-token").set("Authorization", `Bearer ${trackedLink()}`).send({ token: "t" })).status).toBe(401);
  });
  it("lender Q&A open questions: owner 200, other client 403, staff 200", async () => {
    const path = `/api/portal/applications/${APP_ID}/qa/open`;
    expect((await request(app).get(path).set("Authorization", `Bearer ${client()}`)).status).toBe(200);
    expect((await request(app).get(path).set("Authorization", `Bearer ${client("+15875550199")}`)).status).toBe(403);
    expect((await request(app).get(path).set("Authorization", `Bearer ${staff()}`)).status).toBe(200);
  });
  it("lender Q&A answer is scoped to the application's sets", async () => {
    await request(app)
      .patch(`/api/portal/applications/${APP_ID}/qa/questions/q1/answer`)
      .set("Authorization", `Bearer ${client()}`)
      .send({ answer_text: "yes" });
    const update = queryMock.mock.calls.find(([sql]) => String(sql).includes("UPDATE qa_questions"));
    expect(String(update?.[0])).toContain("set_id IN (SELECT id FROM qa_sets WHERE application_id::text = ($5)::text)");
    expect(update?.[1]?.[4]).toBe(APP_ID);
  });
});

describe("POST /api/messages (item 5)", () => {
  it("requires a staff token", async () => {
    expect((await request(app).post("/api/messages").send({ applicationId: APP_ID, body: "hi" })).status).toBe(401);
    expect((await request(app).post("/api/messages").set("Authorization", `Bearer ${client()}`).send({ applicationId: APP_ID, body: "hi" })).status).toBe(403);
  });
});
