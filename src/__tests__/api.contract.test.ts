import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";

const app = buildAppWithApiRoutes();

describe("API contract: JSON-only responses", () => {
  it("GET /api/_int/health returns JSON", async () => {
    const res = await request(app).get("/api/_int/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.ok).toBe(true);
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("POST /api/auth/otp/start returns JSON", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "not-a-phone" });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("Unknown /api route returns JSON 404", async () => {
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("Non-API route may return HTML", async () => {
    const res = await request(app).get("/");
    const contentType = res.headers["content-type"] ?? "";
    const isHtml = contentType.includes("text/html");
    const isJson = contentType.includes("application/json");

    expect(isHtml || isJson).toBe(true);
    if (isHtml) {
      expect(res.text).toMatch(/<!doctype|<html/i);
    }
  });
});
