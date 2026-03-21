import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";

const app = buildAppWithApiRoutes();

describe("/api/auth/me safety", () => {
  it("returns 401 for invalid tokens", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalid.token.value");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });
});
