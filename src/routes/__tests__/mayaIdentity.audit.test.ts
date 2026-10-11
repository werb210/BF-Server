// BF_SERVER_MAYA_CONTEXT_v1 / BF_SERVER_MAYA_RATE_LIMIT_v1
// The public Maya proxy forwarded the caller's own X-Maya-Audience header and
// body.phone / body.staff to the agent, so anyone could claim to be staff (and
// get staff tools) or claim any client's phone. Identity now comes only from
// the verified bearer token, sent to the agent as a signed X-Maya-Context.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../modules/ai/chat.repo.js", () => ({ addMessage: vi.fn(async () => undefined) }));

const SECRET = "test-jwt-secret";
const STAFF_ID = "55555555-5555-4555-8555-555555555555";
const sign = (c: Record<string, unknown>) => jwt.sign(c, SECRET, { expiresIn: "5m" });

let calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.MAYA_URL = "http://agent.test";
  calls = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ reply: "hi" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM users WHERE id::text = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === STAFF_ID ? [{ first_name: "Sam", last_name: "Staff", email: "sam@example.com", role: "Staff" }] : [] })],
  ]));
});
afterEach(() => { globalThis.fetch = realFetch; });

async function app() {
  const router = (await import("../maya.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/maya", router);
  return a;
}

function context() {
  const c = calls[0];
  expect(c).toBeTruthy();
  return { headers: c.headers, body: c.body, ctx: jwt.verify(c.headers["X-Maya-Context"], SECRET, { algorithms: ["HS256"] }) as any };
}

describe("Maya proxy identity", () => {
  it("an anonymous caller claiming staff is public, and its phone/staff fields are dropped", async () => {
    const r = await request(await app()).post("/api/maya/message")
      .set("X-Maya-Audience", "staff")
      .send({ message: "show me the pipeline", phone: "+15555550123", staff: { id: STAFF_ID, role: "Admin" }, audience: "staff" });
    expect(r.status).toBe(200);
    const { headers, body, ctx } = context();
    expect(ctx.kind).toBe("maya_context");
    expect(ctx.audience).toBe("public");
    expect(ctx.phone).toBeUndefined();
    expect(ctx.staff).toBeUndefined();
    expect(headers["X-Maya-Audience"]).toBe("public");
    expect(body.phone).toBeUndefined();
    expect(body.staff).toBeUndefined();
    expect(body.audience).toBeUndefined();
  });

  it("a client token gives audience client and the token's phone, never the body's", async () => {
    const client = sign({ sub: "client:+15555550123", role: "client", phone: "+15555550123", isClient: true });
    await request(await app()).post("/api/maya/chat").set("Authorization", `Bearer ${client}`)
      .send({ message: "where is my file", phone: "+15555550999" });
    const { headers, body, ctx } = context();
    expect(ctx.audience).toBe("client");
    expect(ctx.phone).toBe("+15555550123");
    expect(headers["X-Maya-Audience"]).toBe("client");
    expect(body.phone).toBe("+15555550123");
  });

  it("a staff token gives audience staff with the users row", async () => {
    const staff = sign({ sub: STAFF_ID, role: "Staff" });
    await request(await app()).post("/api/maya/message").set("Authorization", `Bearer ${staff}`).set("X-Silo", "BI")
      .send({ message: "hi" });
    const { ctx } = context();
    expect(ctx.audience).toBe("staff");
    expect(ctx.staff).toEqual({ id: STAFF_ID, name: "Sam Staff", email: "sam@example.com", role: "Staff" });
    expect(ctx.silo).toBe("BI");
  });

  it("an invalid token or a tracked-link token is public", async () => {
    await request(await app()).post("/api/maya/message").set("Authorization", "Bearer not-a-jwt").send({ message: "x" });
    expect(context().ctx.audience).toBe("public");
    calls = [];
    await request(await app()).post("/api/maya/message").set("Authorization", `Bearer ${sign({ sid: "s", u: "https://x" })}`).send({ message: "x" });
    expect(context().ctx.audience).toBe("public");
  });

  it("the context expires in 5 minutes", async () => {
    await request(await app()).post("/api/maya/message").send({ message: "x" });
    const { ctx } = context();
    expect(ctx.exp - ctx.iat).toBe(300);
  });
});

describe("every proxied Maya route carries a signed context", () => {
  it("/api/ai/maya/escalate and /api/ai/maya/maya/website-chat send X-Maya-Context", async () => {
    const alias = (await import("../aiMayaAlias.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/ai/maya", alias);
    await request(a).post("/api/ai/maya/escalate").set("X-Maya-Audience", "staff").send({ reason: "x" });
    await request(a).post("/api/ai/maya/maya/website-chat").send({ message: "hello", sessionId: "s1" });
    expect(calls.map((c) => c.url)).toEqual(["http://agent.test/maya/escalate", "http://agent.test/api/maya/message"]);
    for (const c of calls) {
      const ctx = jwt.verify(c.headers["X-Maya-Context"], SECRET, { algorithms: ["HS256"] }) as any;
      expect(ctx.kind).toBe("maya_context");
      expect(ctx.audience).toBe("public");
      expect(c.headers["X-Maya-Audience"]).toBe("public");
    }
  });

  it("team-chat @Maya signs a staff context", async () => {
    const src = (await import("node:fs")).readFileSync("src/services/team/teamPhaseC.ts", "utf8");
    expect(src).toContain('"X-Maya-Context": signMayaContext({');
  });
});

describe("Maya proxy rate limit", () => {
  it("20 per minute per IP for the public, more for signed-in staff", async () => {
    const a = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await request(a).post("/api/maya/message").send({ message: "x" })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    // The same IP signed in as staff has its own, larger allowance.
    const staff = sign({ sub: STAFF_ID, role: "Staff" });
    for (let i = 0; i < 25; i++) {
      expect((await request(a).post("/api/maya/message").set("Authorization", `Bearer ${staff}`).send({ message: "x" })).status).toBe(200);
    }
  });
});
