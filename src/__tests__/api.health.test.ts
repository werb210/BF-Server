import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";

const app = buildAppWithApiRoutes();

describe("API health and fallback", () => {
  it("returns JSON for /api/_int/health", async () => {
    const res = await request(app).get("/api/_int/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.ok).toBe(true);
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("returns JSON 404 for unknown /api routes", async () => {
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("not_found");
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });
});
