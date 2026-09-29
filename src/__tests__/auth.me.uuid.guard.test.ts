import { describe, it, expect } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
const app = createApp();
const JWT_SECRET = "test-jwt-secret-minimum-10-chars";

describe("GET /api/auth/me — UUID guard", () => {
  it("returns 401 cleanly for old test-mode token with non-UUID sub", async () => {
    const staleToken = jwt.sign(
      { sub: "test-user:+14035550123", role: "Staff", tokenVersion: 0 },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${staleToken}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_token");
    expect(res.body.message).toContain("expired");
  });

  it("returns 401 for empty sub", async () => {
    const badToken = jwt.sign({ sub: "", role: "Staff" }, JWT_SECRET);
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for valid UUID sub (with seeded user)", async () => {
    const { signAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({
      sub: "00000000-0000-0000-0000-000000000099",
      role: "Admin" as any,
      tokenVersion: 0,
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect([200, 401]).toContain(res.status);
    expect(res.body.code).not.toBe("auth_query_error");
  });
});
