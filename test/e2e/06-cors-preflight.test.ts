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

  it("returns 200 for OPTIONS /auth/otp/start", async () => {
    const res = await request(app)
      .options("/auth/otp/start")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(200);
  });

  it("returns 200 for OPTIONS /auth/otp/verify", async () => {
    const res = await request(app)
      .options("/auth/otp/verify")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(200);
  });

  it("accepts POST /auth/otp/start from allowed portal origin", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .set("Origin", portalOrigin)
      .send({ phone: "+15555550123" });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(portalOrigin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never returns 404 or 405 for preflight on unknown routes", async () => {
    const res = await request(app)
      .options("/unknown/route")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect([404, 405]).not.toContain(res.status);
    expect(res.status).toBe(200);
  });
});
