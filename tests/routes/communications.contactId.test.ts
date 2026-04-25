import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/middleware/silo.js", () => ({
  getSilo: () => "BF",
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
    vi.spyOn(pool, "query").mockResolvedValue({
      rows: [{ id: "m1", body: "hello", contact_id: "c1", silo: "BF" }],
    } as any);
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

  it("returns 400 when no contact id query param is provided", async () => {
    const res = await request(app())
      .get("/api/communications/messages")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
