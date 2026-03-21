import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
const app = buildAppWithApiRoutes();

beforeAll(async () => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

describe("auth routes never return 500", () => {
  it("rejects auth requests without 500s", async () => {
    const responses = await Promise.all([
      request(app).post("/api/auth/otp/start").send({ phone: "invalid" }),
      request(app).post("/api/auth/otp/verify").send({ phone: "invalid", code: "" }),
      request(app).get("/api/auth/me"),
    ]);

    responses.forEach((res) => {
      expect(res.status).not.toBe(500);
    });
  });
});
