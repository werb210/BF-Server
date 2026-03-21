import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";

describe("production CORS allowlist", () => {
  const app = buildAppWithApiRoutes();

  it.each([
    "https://client.boreal.financial",
    "https://staff.boreal.financial",
    "https://server.boreal.financial",
  ])("allows preflight requests from %s", async (origin) => {
    const res = await request(app || require("../src/app").default)
      .options("/api/health")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
