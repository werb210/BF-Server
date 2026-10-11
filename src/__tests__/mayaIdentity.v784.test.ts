// BF_SERVER_v784_MAYA_IDENTITY - who Maya is talking to comes only from the verified token.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params?: unknown[]) => {
    if (/FROM users WHERE id::text = \$1/.test(sql)) {
      if (params?.[0] === STAFF_ID) {
        return { rows: [{ id: STAFF_ID, first_name: "Sam", last_name: "Staff", email: "sam@boreal.test", role: "Staff", silo: "BF", silos: ["BF", "BI"] }] };
      }
      return { rows: [] };
    }
    if (/INSERT INTO team_messages/i.test(sql)) return { rows: [{ id: "reply-1", channel_id: "c1", body: "ok" }] };
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query };
});
vi.mock("../ws/teamSocket.js", () => ({ broadcastToUsers: () => undefined }));
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: async () => undefined }));

import mayaRoutes from "../routes/maya.js";
import aiMayaAlias from "../routes/aiMayaAlias.js";
import { askMaya } from "../services/team/teamPhaseC.js";
import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";

const app = express();
app.use(express.json());
app.use("/api/maya", API_ROUTE_MOUNTS.find((m) => m.path === "/maya")!.router);
app.use("/api/ai/maya", aiMayaAlias);
const bareMaya = express();
bareMaya.use(express.json());
bareMaya.use("/api/maya", mayaRoutes);

const staffTok = "Bearer " + jwt.sign({ id: STAFF_ID, sub: STAFF_ID, role: "Staff" }, SECRET, { algorithm: "HS256" });
const clientTok = "Bearer " + jwt.sign({ sub: "client:+17805550100", role: "client", isClient: true, phone: "+17805550100" }, SECRET, { algorithm: "HS256" });
const serviceTok = "Bearer " + jwt.sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" }, SECRET, { algorithm: "HS256" });
const forgedTok = "Bearer " + jwt.sign({ id: STAFF_ID, sub: STAFF_ID, role: "Admin" }, "not-the-secret", { algorithm: "HS256" });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.MAYA_URL = "http://maya.test";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "hi" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MAYA_URL;
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, any];
  const ctx = jwt.verify(init.headers["X-Maya-Context"], SECRET, { algorithms: ["HS256"] }) as any;
  return { url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body) : null, ctx };
}

describe("v784 Maya identity from the verified token only", () => {
  it("anonymous caller is public even with forged header and body claims", async () => {
    const r = await request(app).post("/api/maya/message")
      .set("X-Maya-Audience", "staff")
      .send({ message: "hi", phone: "+17805550100", staff: { id: STAFF_ID, role: "Admin" }, audience: "staff" });
    expect(r.status).toBe(200);
    const c = lastCall();
    expect(c.url).toBe("http://maya.test/api/maya/message");
    expect(c.headers["X-Maya-Audience"]).toBe("public");
    expect(c.ctx).toMatchObject({ kind: "maya_context", audience: "public" });
    expect(c.ctx.phone).toBeUndefined();
    expect(c.ctx.staff).toBeUndefined();
    expect(c.body).toEqual({ message: "hi" });
    expect(c.ctx.exp - c.ctx.iat).toBe(300);
  });

  it("a token signed with the wrong secret is public", async () => {
    await request(app).post("/api/maya/chat").set("Authorization", forgedTok).send({ message: "hi" });
    expect(lastCall().ctx.audience).toBe("public");
  });

  it("client token -> client + phone from the token, body phone ignored", async () => {
    await request(app).post("/api/maya/message").set("Authorization", clientTok).set("X-Maya-Audience", "staff").send({ message: "hi", phone: "+15555550000" });
    const c = lastCall();
    expect(c.headers["X-Maya-Audience"]).toBe("client");
    expect(c.ctx).toMatchObject({ audience: "client", phone: "+17805550100" });
    expect(c.body.phone).toBeUndefined();
  });

  it("staff token -> staff identity loaded from users, body staff ignored", async () => {
    await request(app).post("/api/maya/chat").set("Authorization", staffTok).set("X-Silo", "BI").send({ message: "hi", staff: { id: "evil", role: "Admin" } });
    const c = lastCall();
    expect(c.url).toBe("http://maya.test/api/maya/chat");
    expect(c.headers["X-Maya-Audience"]).toBe("staff");
    expect(c.ctx.staff).toEqual({ id: STAFF_ID, name: "Sam Staff", email: "sam@boreal.test", role: "Staff" });
    expect(c.ctx.silo).toBe("BI");
    expect(c.body.staff).toBeUndefined();
  });

  it("service token is treated as public", async () => {
    await request(app).post("/api/maya/message").set("Authorization", serviceTok).send({ message: "hi" });
    expect(lastCall().ctx.audience).toBe("public");
  });

  it("/api/maya/website-chat sends X-Maya-Context", async () => {
    await request(app).post("/api/maya/website-chat").set("X-Maya-Audience", "staff").send({ message: "hi", sessionId: "s1" });
    const c = lastCall();
    expect(c.url).toBe("http://maya.test/api/maya/message");
    expect(c.ctx.audience).toBe("public");
    expect(c.body.audience).toBeUndefined();
  });

  it("/api/ai/maya aliases (message, chat, escalate, website-chat) send X-Maya-Context", async () => {
    const paths: Array<[string, string]> = [
      ["/api/ai/maya/message", "/api/maya/message"],
      ["/api/ai/maya/chat", "/api/maya/chat"],
      ["/api/ai/maya/escalate", "/maya/escalate"],
      ["/api/ai/maya/maya/website-chat", "/api/maya/message"],
    ];
    for (const [p, upstream] of paths) {
      await request(app).post(p).set("Authorization", clientTok).set("X-Maya-Audience", "staff").send({ message: "hi", phone: "+15555550000" });
      const c = lastCall();
      expect(c.url).toBe("http://maya.test" + upstream);
      expect(c.ctx).toMatchObject({ audience: "client", phone: "+17805550100" });
      expect(c.headers["X-Maya-Audience"]).toBe("client");
      expect(c.body.phone).toBeUndefined();
    }
  });

  it("bare maya router also derives identity", async () => {
    await request(bareMaya).post("/api/maya/message").set("Authorization", staffTok).send({ message: "hi" });
    expect(lastCall().ctx.audience).toBe("staff");
  });

  it("team chat @Maya sends the posting staff user's identity", async () => {
    const ok = await askMaya("c1", { id: "m1", body: "@Maya how many deals?" }, STAFF_ID);
    expect(ok).toBe(true);
    const c = lastCall();
    expect(c.url).toBe("http://maya.test/api/maya/message");
    expect(c.headers["X-Maya-Audience"]).toBe("staff");
    expect(c.ctx).toMatchObject({ kind: "maya_context", audience: "staff", silo: "BF" });
    expect(c.ctx.staff).toMatchObject({ id: STAFF_ID, name: "Sam Staff" });
    expect(c.body.staff).toBeUndefined();
  });
});
