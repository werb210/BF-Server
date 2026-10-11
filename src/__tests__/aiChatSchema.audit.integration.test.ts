// BF_SERVER_CHAT_MESSAGES_NOT_NULL_v1 / BF_SERVER_CHAT_SESSIONS_UPDATED_AT_v1
// Against the real schema: /api/ai/ai/message inserted chat_messages without the
// NOT NULL message column, and /ai/escalate, /ai/close and GET /api/admin/chats used
// chat_sessions.updated_at, which the live schema did not have.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

vi.mock("../modules/ai/ai.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/ai/ai.service.js")),
  generateAIResponse: async () => JSON.stringify({ reply: "ok" }),
}));

import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const adminId = randomUUID();
const admin = jwt.sign({ sub: adminId, role: "Admin" }, SECRET, { algorithm: "HS256" });

describe("AI chat routes match the live chat schema", () => {
  const app = createApp();
  let sessionId = "";

  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    await pool.query(
      "INSERT INTO users (id, email, role, active) VALUES ($1, $2, 'Admin', true) ON CONFLICT DO NOTHING",
      [adminId, `admin-${adminId}@example.com`],
    );
  });

  afterAll(async () => {
    if (sessionId) {
      await pool.query("DELETE FROM chat_queue WHERE session_id = $1", [sessionId]);
      await pool.query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
      await pool.query("DELETE FROM chat_sessions WHERE id = $1", [sessionId]);
    }
    await pool.query("DELETE FROM users WHERE id = $1", [adminId]);
  });

  it("start + message persist a row with both message and content", async () => {
    const start = await request(app).post("/api/ai/ai/start").send({ source: "website" });
    expect(start.status).toBe(200);
    sessionId = start.body.sessionId;
    const msg = await request(app).post("/api/ai/ai/message").send({ sessionId, message: "Do you do equipment loans?" });
    expect(msg.status).toBe(200);
    const rows = await pool.query("SELECT role, message, content FROM chat_messages WHERE session_id = $1", [sessionId]);
    expect(rows.rows).toEqual([{ role: "user", message: "Do you do equipment loans?", content: "Do you do equipment loans?" }]);
  });

  it("confidence-check writes a system message", async () => {
    const r = await request(app).post("/api/ai/ai/confidence-check").send({ sessionId, score: 0.4 });
    expect(r.status).toBe(200);
    expect(r.body.escalateRecommended).toBe(true);
  });

  it("escalate and close update the session (updated_at exists)", async () => {
    expect((await request(app).post("/api/ai/ai/escalate").send({ sessionId })).status).toBe(200);
    const closed = await request(app).post("/api/ai/ai/close").send({ sessionId });
    expect(closed.status).toBe(200);
    const s = await pool.query("SELECT status, updated_at FROM chat_sessions WHERE id = $1", [sessionId]);
    expect(s.rows[0].status).toBe("closed");
    expect(s.rows[0].updated_at).toBeTruthy();
  });

  it("GET /api/admin/chats lists the closed chat with its transcript", async () => {
    const r = await request(app).get("/api/admin/chats").set("Authorization", `Bearer ${admin}`);
    expect(r.status).toBe(200);
    const mine = (r.body as any[]).find((c) => c.id === sessionId);
    expect(mine?.status).toBe("closed");
    expect(mine?.transcript).toContain("Do you do equipment loans?");
  });
});
