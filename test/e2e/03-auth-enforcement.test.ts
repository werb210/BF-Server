import request from "supertest";
import type { Express } from "express";
import jwt from "jsonwebtoken";

import { createServer } from "../../src/server/createServer";
import { loadTestEnv } from "../utils/testEnv";

describe("Auth enforcement", () => {
  let app: Express;
  const testSecret = "test-secret-32-characters-minimum!!";

  beforeAll(() => {
    loadTestEnv({ JWT_SECRET: testSecret });
    app = createServer();
  });

  it("rejects missing header", async () => {
    const res = await request(app).get("/api/voice/token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      error: "Unauthorized",
    });
  });

  it("returns 200 with valid token", async () => {
    const token = jwt.sign({ userId: "test-user", role: "tester" }, testSecret, {
      expiresIn: "1h",
    });

    const res = await request(app)
      .get("/api/voice/token")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.data?.token).toBe("string");
    expect(res.body.data.token.length).toBeGreaterThan(0);
  });

  it("rejects empty token", async () => {
    const res = await request(app)
      .get("/api/voice/token")
      .set("Authorization", "Bearer ");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      error: "Unauthorized",
    });
  });

  it("rejects malformed token", async () => {
    const res = await request(app)
      .get("/api/voice/token")
      .set("Authorization", "Bearer not.a.valid.jwt");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      error: "Unauthorized",
    });
  });

  it("rejects expired token", async () => {
    const expired = jwt.sign({ userId: "test-user", role: "tester" }, testSecret, {
      expiresIn: -1,
    });

    const res = await request(app)
      .get("/api/voice/token")
      .set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      error: "Unauthorized",
    });
  });

  it("rejects token signed with wrong secret", async () => {
    const wrongSecretToken = jwt.sign({ userId: "test-user", role: "tester" }, "wrong-secret", {
      expiresIn: "1h",
    });

    const res = await request(app)
      .get("/api/voice/token")
      .set("Authorization", `Bearer ${wrongSecretToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      status: "error",
      error: "Unauthorized",
    });
  });

  it("ensures every 401 response has status and error envelope", async () => {
    const res = await request(app).get("/api/voice/token");

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("status", "error");
    expect(typeof res.body.error).toBe("string");
  });
});
