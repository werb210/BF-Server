import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server/createServer.js";

function bearerToken(role: "Admin" | "Staff") {
  const token = jwt.sign({ id: "u1", userId: "u1", role }, process.env.JWT_SECRET || "test-jwt-secret");
  return `Bearer ${token}`;
}

describe("Maya admin stubs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /overview returns implemented false", async () => {
    const res = await request(createServer())
      .get("/api/maya/overview")
      .set("authorization", bearerToken("Admin"));

    expect(res.status).toBe(200);
    expect(res.body.data?.implemented).toBe(false);
  });

  it("GET /metrics returns implemented false", async () => {
    const res = await request(createServer())
      .get("/api/maya/metrics")
      .set("authorization", bearerToken("Admin"));

    expect(res.status).toBe(200);
    expect(res.body.data?.implemented).toBe(false);
  });

  it("POST /roi-simulate echoes budget", async () => {
    const res = await request(createServer())
      .post("/api/maya/roi-simulate")
      .set("authorization", bearerToken("Admin"))
      .send({ budget: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data?.budget).toBe(1000);
  });

  it("POST /model-rollback returns 501", async () => {
    const res = await request(createServer())
      .post("/api/maya/model-rollback")
      .set("authorization", bearerToken("Admin"));

    expect(res.status).toBe(501);
  });
});
