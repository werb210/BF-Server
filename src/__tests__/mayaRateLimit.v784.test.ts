// BF_SERVER_v784_MAYA_RATE_LIMIT - 20/min per IP anonymous, 120/min per staff user.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string) => {
    if (/FROM users WHERE id::text = \$1/.test(sql)) return { rows: [{ first_name: "Sam", last_name: "Staff", email: "s@x", role: "Staff", silo: "BF", silos: [] }] };
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query };
});
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: async () => undefined }));

import mayaRoutes from "../routes/maya.js";
import aiMayaAlias from "../routes/aiMayaAlias.js";

const app = express();
app.use(express.json());
app.use("/api/maya", mayaRoutes);
app.use("/api/ai/maya", aiMayaAlias);
const staffTok = "Bearer " + jwt.sign({ id: STAFF_ID, sub: STAFF_ID, role: "Staff" }, SECRET, { algorithm: "HS256" });

beforeAll(() => {
  process.env.MAYA_RATE_LIMIT_IN_TESTS = "1";
  process.env.MAYA_URL = "http://maya.test";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reply: "hi" }), { status: 200 })));
});
afterAll(() => {
  delete process.env.MAYA_RATE_LIMIT_IN_TESTS;
  delete process.env.MAYA_URL;
  vi.unstubAllGlobals();
});

describe("v784 Maya proxy rate limit", () => {
  it("anonymous callers get 20 per minute per IP, shared across Maya routes", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 20; i += 1) {
      const path = i % 2 ? "/api/maya/message" : "/api/ai/maya/chat";
      const r = await request(app).post(path).set("X-Forwarded-For", ip).send({ message: "hi" });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).post("/api/maya/chat").set("X-Forwarded-For", ip).send({ message: "hi" });
    expect(blocked.status).toBe(429);
    // A different IP is unaffected.
    expect((await request(app).post("/api/maya/chat").set("X-Forwarded-For", "203.0.113.11").send({ message: "hi" })).status).toBe(200);
  });

  it("a forged X-Maya-Audience header does not lift the anonymous limit", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 20; i += 1) {
      await request(app).post("/api/maya/message").set("X-Forwarded-For", ip).set("X-Maya-Audience", "staff").send({ message: "hi" });
    }
    expect((await request(app).post("/api/maya/message").set("X-Forwarded-For", ip).set("X-Maya-Audience", "staff").send({ message: "hi" })).status).toBe(429);
  });

  it("staff users get 120 per minute keyed by user id, not IP", async () => {
    for (let i = 0; i < 120; i += 1) {
      const r = await request(app).post("/api/maya/message").set("X-Forwarded-For", `198.51.100.${i % 200}`).set("Authorization", staffTok).send({ message: "hi" });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).post("/api/maya/message").set("X-Forwarded-For", "198.51.100.250").set("Authorization", staffTok).send({ message: "hi" });
    expect(blocked.status).toBe(429);
  });

  it("is skipped under NODE_ENV=test unless explicitly enabled", async () => {
    delete process.env.MAYA_RATE_LIMIT_IN_TESTS;
    const ip = "203.0.113.30";
    for (let i = 0; i < 25; i += 1) {
      expect((await request(app).post("/api/maya/message").set("X-Forwarded-For", ip).send({ message: "hi" })).status).toBe(200);
    }
    process.env.MAYA_RATE_LIMIT_IN_TESTS = "1";
  });
});
