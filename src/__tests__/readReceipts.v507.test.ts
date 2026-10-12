// BF_SERVER_BLOCK_v507_READ_RECEIPTS
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import clientRouter from "../routes/client/index.js";
import communications from "../routes/communications.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
app.use("/api/communications", communications);

const READ = "2026-10-05T12:00:00.000Z";
beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
    [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
    [/WITH thread AS/, { rows: [
      { id: "m1", direction: "outbound", body: "Seen", staff_name: "Todd", created_at: "2026-10-05T11:00:00Z", read_at: READ },
      { id: "m2", direction: "outbound", body: "Not yet", staff_name: "Todd", created_at: "2026-10-05T11:30:00Z" },
    ] }],
    [/FROM communications_conversations cc/, { rows: [{ id: "conv-1", session_id: "conv-1", channel: "chat", contact_silo: "BF", created_at: "2026-10-05T10:00:00Z" }] }],
    [/FROM communications_messages\s+WHERE conversation_id = \$1/, { rows: [
      { id: "x1", direction: "outbound", body: "Hello", created_at: "2026-10-05T11:00:00Z", read_at: READ },
      { id: "x2", direction: "inbound", body: "Hi", created_at: "2026-10-05T11:05:00Z", read_at: null },
    ] }],
  ]));
});

describe("v507 read receipts", () => {
  it("client message list returns read_at", async () => {
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token);
    expect(r.status).toBe(200);
    expect(r.body.data.map((m: any) => [m.id, m.read_at])).toEqual([["m1", READ], ["m2", null]]);
    expect(sqlText(callsMatching(h.query, /WITH thread AS/)[0]![0])).toMatch(/created_at, read_at/);
  });

  it("conversation detail returns readAt", async () => {
    const staff = "Bearer " + jwt.sign({ sub: "88888888-8888-4888-8888-888888888888", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const r = await request(app).get("/api/communications/threads/conv-1").set("Authorization", staff);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: any) => [m.id, m.readAt])).toEqual([["x1", READ], ["x2", null]]);
    expect(sqlText(callsMatching(h.query, /WHERE conversation_id = \$1/)[0]![0])).toContain("created_at, read_at");
  });
});
