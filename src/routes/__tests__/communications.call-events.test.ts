import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

const token = jwt.sign({ id: "00000000-0000-0000-0000-000000000001", role: "Staff", capabilities: ["communications:read"] }, "test-secret");

describe("communications call-events", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      return { rows: [] };
    });
  });

  it("POST /call-events writes row and returns 201", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("INSERT INTO call_events")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111", occurred_at: "2026-05-18T00:00:00.000Z" }] };
      return { rows: [] };
    });
    const router = (await import("../communications.js")).default;
    const app = express(); app.use(express.json()); app.use("/api/communications", router);
    const res = await request(app).post("/api/communications/call-events").set("Authorization", `Bearer ${token}`).send({ event_type: "call.started", to_number: "+15555550123" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });
});
