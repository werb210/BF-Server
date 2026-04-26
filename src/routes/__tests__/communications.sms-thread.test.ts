import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

const token = jwt.sign({ id: "00000000-0000-0000-0000-000000000001", capabilities: ["communications:read"] }, "test-secret");

describe("communications sms thread", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "staff", silo: "BF", silos: ["BF"] }] };
      return { rows: [] };
    });
  });

  async function buildApp() {
    const router = (await import("../communications.js")).default;
    const app = express();
    app.use("/api/communications", router);
    return app;
  }

  it("returns 200 with empty messages when no records exist", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/communications/sms/thread?contactId=00000000-0000-0000-0000-000000000099").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("accepts synthetic new- phone key and returns 200", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/communications/sms/thread?contactId=new-15878881837").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });
});
