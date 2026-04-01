import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";

describe("Global CORS and deterministic preflight behavior", () => {
  const portalOrigin = "https://portal.example.com";
  let app: Express;

  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = portalOrigin;
    app = createServer();
  });

  afterAll(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it("returns 200 for OPTIONS /api/auth/otp/start", async () => {
    const res = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(200);
  });

  it("returns 200 for OPTIONS /api/auth/otp/verify", async () => {
    const res = await request(app)
      .options("/api/auth/otp/verify")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(200);
  });

  it("accepts POST /api/auth/otp/start from allowed portal origin", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .set("Origin", portalOrigin)
      .send({ phone: "+15555550123" });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(portalOrigin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects non-/api preflight routes with strict legacy disablement", async () => {
    const res = await request(app)
      .options("/unknown/route")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ success: false, error: "LEGACY_ROUTE_DISABLED" });
  });
});
