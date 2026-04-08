import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";

describe("Global CORS and deterministic preflight behavior", () => {
  const portalOrigin = "https://staff.boreal.financial";
  let app: Express;

  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = portalOrigin;
    app = createServer();
  });

  afterAll(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it("returns 204 for OPTIONS /api/auth/otp/start", async () => {
    const res = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
  });

  it("returns 204 for OPTIONS /api/auth/otp/verify", async () => {
    const res = await request(app)
      .options("/api/auth/otp/verify")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
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

  it("returns 204 for non-/api preflight routes when origin is present", async () => {
    const res = await request(app)
      .options("/unknown/route")
      .set("Origin", portalOrigin)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
  });
});
