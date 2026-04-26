import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import communicationsRouter from "../../src/routes/communications.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("GET /api/communications/sms/thread synthetic keys", () => {
  const token = jwt.sign(
    { id: "user-1", capabilities: ["communications:read"] },
    "test-secret"
  );

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JWT_SECRET = "test-secret";
    vi.spyOn(pool, "query").mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id")) {
        return {
          rows: [{ id: "user-1", email: "test@example.com", role: "Admin", silo: "BF", silos: ["BF"] }],
        } as any;
      }
      return { rows: [] } as any;
    });
  });

  function app() {
    const a = express();
    a.use("/api/communications", communicationsRouter);
    a.use(errorHandler);
    return a;
  }

  it("accepts new-<digits> synthetic contactId without throwing", async () => {
    const res = await request(app())
      .get("/api/communications/sms/thread")
      .set("Authorization", `Bearer ${token}`)
      .query({ contactId: "new-5878881837" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });
});
