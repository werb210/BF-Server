import request from "supertest";
import type { Express } from "express";
import jwt from "jsonwebtoken";

import { createServer } from "../../src/server/createServer";
import { loadTestEnv } from "../utils/testEnv";

describe("Auth enforcement", () => {
  let app: Express;
  const testSecret = "test-secret";

  beforeAll(() => {
    loadTestEnv({ JWT_SECRET: testSecret });
    app = createServer();
  });

  it("rejects missing header", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED" });
  });

  it("returns 200 with valid token", async () => {
    const token = jwt.sign({ userId: "test-user", role: "tester" }, testSecret, {
      expiresIn: "1h",
    });

    const res = await request(app)
      .get("/api/health")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });


  it("rejects empty token", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Authorization", "Bearer ");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_TOKEN" });
  });

  it("rejects malformed token", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Authorization", "Bearer not.a.valid.jwt");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_TOKEN" });
  });

  it("rejects expired token", async () => {
    const expired = jwt.sign({ userId: "test-user", role: "tester" }, testSecret, {
      expiresIn: -1,
    });

    const res = await request(app)
      .get("/api/health")
      .set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_TOKEN" });
  });

  it("rejects token signed with wrong secret", async () => {
    const wrongSecretToken = jwt.sign({ userId: "test-user", role: "tester" }, "wrong-secret", {
      expiresIn: "1h",
    });

    const res = await request(app)
      .get("/api/health")
      .set("Authorization", `Bearer ${wrongSecretToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_TOKEN" });
  });
});
