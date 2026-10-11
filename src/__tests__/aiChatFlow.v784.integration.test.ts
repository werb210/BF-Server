// BF_SERVER_v784_CHAT_SCHEMA - real-Postgres run of the ai.v2 chat flow
// (start -> message -> escalate -> close) and the admin chats list. The live
// chat_messages table has BOTH message and content NOT NULL, and chat_sessions
// had no updated_at until migrations/2026_10_11_chat_sessions_updated_at.sql;
// either gap made these routes 500 in production while mocked tests passed.
// Needs Postgres: registered in vitest.integration.ts (npm run test:integration).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

vi.mock("../modules/ai/ai.service.js", async (orig) => ({
  ...(await orig<any>()),
  generateAIResponse: vi.fn(async () => JSON.stringify({ reply: "Happy to help.", askIntakeQuestions: false })),
}));

import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const adminToken = jwt.sign({ id: randomUUID(), sub: "00000000-0000-0000-0000-0000000000aa", role: "Admin" }, SECRET, { algorithm: "HS256" });
const sessionIds: string[] = [];

// Mirrors the live definitions (migrations/000000_baseline.sql). No-ops where the
// baseline already built them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  staff_override boolean DEFAULT false NOT NULL,
  status varchar(50) DEFAULT 'ai' NOT NULL CHECK (status IN ('ai','queued','live','closed')),
  source varchar(50) DEFAULT 'website' NOT NULL,
  channel varchar(20) DEFAULT 'text' NOT NULL,
  lead_id uuid,
  crm_contact_id uuid,
  assigned_to uuid
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid,
  created_at timestamptz DEFAULT now(),
  message text NOT NULL,
  metadata jsonb,
  content text NOT NULL,
  role text
);
CREATE TABLE IF NOT EXISTS chat_queue (
  id uuid NOT NULL,
  session_id uuid REFERENCES chat_sessions(id),
  priority integer DEFAULT 1,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name text,
  last_name text,
  email text,
  silo text
);
`;

describe("v784 ai chat flow against real Postgres", () => {
  const app = createApp();

  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    await pool.query(SCHEMA);
    await pool.query(fs.readFileSync("migrations/2026_10_11_chat_sessions_updated_at.sql", "utf8"));
  });

  afterAll(async () => {
    for (const id of sessionIds) {
      await pool.query("DELETE FROM chat_queue WHERE session_id = $1", [id]);
      await pool.query("DELETE FROM chat_messages WHERE session_id = $1", [id]);
      await pool.query("DELETE FROM chat_sessions WHERE id = $1", [id]);
    }
  });

  it("the live chat_messages shape has message and content NOT NULL", async () => {
    const r = await pool.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'chat_messages' AND column_name IN ('message','content')",
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.column_name, x.is_nullable]))).toEqual({ message: "NO", content: "NO" });
  });

  it("start -> message -> escalate -> close, then the admin chats list shows it", async () => {
    const start = await request(app).post("/api/ai/ai/start").send({ source: "website" });
    expect(start.status).toBe(200);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);

    const msg = await request(app).post("/api/ai/ai/message").send({ sessionId, message: "Do you do equipment loans?" });
    expect(msg.status).toBe(200);
    expect(msg.body.reply).toBe("Happy to help.");
    const stored = await pool.query("SELECT role, message, content FROM chat_messages WHERE session_id = $1", [sessionId]);
    expect(stored.rows).toEqual([{ role: "user", message: "Do you do equipment loans?", content: "Do you do equipment loans?" }]);

    const conf = await request(app).post("/api/ai/ai/confidence-check").send({ sessionId, score: 0.4 });
    expect(conf.status).toBe(200);
    const interest = await request(app).post("/api/ai/ai/startup-interest").send({ sessionId, tags: ["equipment"] });
    expect(interest.status).toBe(200);
    const sys = await pool.query("SELECT message, content FROM chat_messages WHERE session_id = $1 AND role = 'system' ORDER BY message", [sessionId]);
    expect(sys.rows).toEqual([
      { message: "confidence_check", content: "confidence_check" },
      { message: "startup_interest", content: "startup_interest" },
    ]);

    const esc = await request(app).post("/api/ai/ai/escalate").send({ sessionId });
    expect(esc.status).toBe(200);
    const queued = await pool.query("SELECT status, updated_at FROM chat_sessions WHERE id = $1", [sessionId]);
    expect(queued.rows[0].status).toBe("queued");
    expect(queued.rows[0].updated_at).toBeTruthy();
    expect((await pool.query("SELECT 1 FROM chat_queue WHERE session_id = $1", [sessionId])).rowCount).toBe(1);

    const close = await request(app).post("/api/ai/ai/close").send({ sessionId });
    expect(close.status).toBe(200);
    expect((await pool.query("SELECT status FROM chat_sessions WHERE id = $1", [sessionId])).rows[0].status).toBe("closed");

    const list = await request(app).get("/api/admin/chats").set("Authorization", "Bearer " + adminToken);
    expect(list.status).toBe(200);
    const row = (list.body as any[]).find((c) => c.id === sessionId);
    expect(row).toBeTruthy();
    expect(row.status).toBe("closed");
    expect(row.transcript).toContain("user: Do you do equipment loans?");
  });
});
