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

  it("returns implemented false for admin overview", async () => {
    const res = await request(createServer())
      .get("/api/maya/overview")
      .set("authorization", bearerToken("Admin"));

    expect(res.status).toBe(200);
    expect(res.body.data?.implemented).toBe(false);
  });

  it("forbids staff access to overview", async () => {
    const res = await request(createServer())
      .get("/api/maya/overview")
      .set("authorization", bearerToken("Staff"));

    expect(res.status).toBe(403);
  });

  it("echoes numeric budget for roi simulation", async () => {
    const res = await request(createServer())
      .post("/api/maya/roi-simulate")
      .set("authorization", bearerToken("Admin"))
      .send({ budget: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data?.budget).toBe(1000);
  });

  it("returns 501 for model rollback", async () => {
    const res = await request(createServer())
      .post("/api/maya/model-rollback")
      .set("authorization", bearerToken("Admin"));

    expect(res.status).toBe(501);
  });
});
