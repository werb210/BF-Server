import request from "supertest";
import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long";

describe("health", () => {
  it("should return ok", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
