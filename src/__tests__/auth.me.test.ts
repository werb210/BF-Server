import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { ROLES } from "../auth/roles.js";
import { createApp } from "../app.js";

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
    vi.resetModules();
  });

  it("returns user with UUID-like sub as id, not phone", async () => {
    const app = createApp();
    const { signAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({
      sub: "00000000-0000-0000-0000-000000000001",
      role: ROLES.STAFF,
      tokenVersion: 0,
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const user = res.body?.data?.user ?? res.body?.user;
    expect(user).toBeDefined();
    expect(user.id).not.toMatch(/^\+/);
    expect(user.role).toBeDefined();
  });
});
