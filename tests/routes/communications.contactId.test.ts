import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/middleware/silo.js", () => ({
  getSilo: () => "BF",
  resolveSiloFromRequest: () => "BF", // BF_SERVER_BLOCK_v578 - auth and routes now resolve silo this way
}));

import { pool } from "../../src/db.js";
import communicationsRouter from "../../src/routes/communications.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("GET /api/communications/messages contactId aliases", () => {
  const token = jwt.sign(
    { id: "user-1", capabilities: ["communications:read"] },
    "test-secret"
  );

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JWT_SECRET = "test-secret";
    // BF_SERVER_BLOCK_v578 - requireAuth looks the user up first; answer that separately.
    vi.spyOn(pool, "query").mockImplementation(async (sql: string) => {
      if (/FROM users/i.test(String(sql))) return { rows: [{ id: "user-1", email: "u@example.com", role: "Admin", silo: "BF", silos: ["BF"] }] } as any;
      return { rows: [{ id: "m1", body: "hello", contact_id: "c1", silo: "BF" }] } as any;
    });
  });

  function app() {
    const a = express();
    a.use("/api/communications", communicationsRouter);
    a.use(errorHandler);
    return a;
  }

  it("accepts snake_case contact_id", async () => {
    const res = await request(app())
      .get("/api/communications/messages")
      .set("Authorization", `Bearer ${token}`)
      .query({ contact_id: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining("FROM communications_messages"), ["c1", "BF"]);
  });

  it("accepts camelCase contactId", async () => {
    const res = await request(app())
      .get("/api/communications/messages")
      .set("Authorization", `Bearer ${token}`)
      .query({ contactId: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining("FROM communications_messages"), ["c1", "BF"]);
  });

  // BF_SERVER_BLOCK_v578 - with no contact the thread is simply empty (the portal opens the
  // panel before a contact is picked), and no message query runs.
  it("returns an empty thread when no contact id is provided", async () => {
    const res = await request(app())
      .get("/api/communications/messages")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], total: 0 });
    expect((pool.query as any).mock.calls.some((c: any[]) => /FROM communications_messages/.test(String(c[0])))).toBe(false);
  });
});
