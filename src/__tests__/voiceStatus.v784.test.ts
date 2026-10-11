// BF_SERVER_v784_VOICE_STATUS - POST /api/voice/status lives on the mounted
// voice router (voiceCalls.ts), requires staff auth, and accepts the dialer's
// {callStatus} body as well as the legacy {callId, status}.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import fs from "node:fs";

vi.mock("../db.js", () => {
  const query = vi.fn(async () => ({ rows: [] }));
  return { pool: { query }, runQuery: query, db: { query }, dbQuery: query, query };
});

import voiceCalls from "../routes/voiceCalls.js";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret";
const staff = jwt.sign({ id: "00000000-0000-0000-0000-0000000000b1", sub: "00000000-0000-0000-0000-0000000000b1", role: "Staff" }, SECRET, { algorithm: "HS256", expiresIn: "5m" });

const app = express();
app.use(express.json());
app.use("/api/voice", voiceCalls);

describe("POST /api/voice/status", () => {
  it("accepts the dialer's {callStatus} body", async () => {
    const r = await request(app).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({ callStatus: "ringing" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ received: true, callStatus: "ringing", callId: null });
  });

  it("still accepts the legacy {callId, status} body", async () => {
    const r = await request(app).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({ callId: "CA123", status: "completed" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ received: true, callStatus: "completed", callId: "CA123" });
  });

  it("400s on a missing or unknown status", async () => {
    expect((await request(app).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({})).status).toBe(400);
    expect((await request(app).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({ callStatus: "exploded" })).status).toBe(400);
  });

  it("requires auth", async () => {
    const r = await request(app).post("/api/voice/status").send({ callStatus: "ringing" });
    expect(r.status).toBe(401);
  });

  it("is gone from the unmounted routes/voice.ts", () => {
    const src = fs.readFileSync("src/routes/voice.ts", "utf8");
    expect(src).not.toContain('router.post("/status"');
  });
});
