import { describe, it, expect } from 'vitest';
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { ROLES } from "../auth/roles";

const app = buildAppWithApiRoutes();

const TOKEN_OPTIONS = {
  expiresIn: "1h",
  issuer: "boreal-staff-server",
  audience: "boreal-staff-portal",
};

describe("auth me smoke", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-access-secret";
  });

  it("accepts a signed token with sub and returns user info", async () => {
    const token = jwt.sign(
      {
        sub: "user-123",
        role: ROLES.STAFF,
        tokenVersion: 0,
      },
      process.env.JWT_SECRET ?? "test-access-secret",
      TOKEN_OPTIONS
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe("user-123");
    expect(res.body.role).toBe(ROLES.STAFF);
    expect(res.body.silo).toBe("BF");
  });

  it("rejects tokens without role claim", async () => {
    const token = jwt.sign(
      {
        sub: "test-user-123",
        tokenVersion: 0,
      },
      process.env.JWT_SECRET ?? "test-access-secret",
      TOKEN_OPTIONS
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});
