import request from "supertest";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestApp } from "./setup";

describe("Auth", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("rejects unauthenticated", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", "Bearer invalid");

    expect(res.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const expiredToken = jwt.sign(
      {
        role: "admin",
        exp: Math.floor(Date.now() / 1000) - 3600,
      },
      process.env.JWT_SECRET ?? "test-secret",
      { subject: "expired-user" },
    );

    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });
});
