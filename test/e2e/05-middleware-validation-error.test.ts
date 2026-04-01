import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { generateTestToken } from "../utils/token";

describe("Middleware execution, validation, and error handling", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("executes CORS middleware and exposes expected headers", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://staff.boreal.financial");

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://staff.boreal.financial",
    );
  });

  it("returns validation failures on malformed OTP payloads", async () => {
    const res = await request(app).post("/api/auth/otp/start").send({ phone: "" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "invalid_payload" });
  });

  it("returns consistent 404 error envelope for unknown routes", async () => {
    const token = generateTestToken();
    const res = await request(app)
      .get("/totally/unknown/path")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(410);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("LEGACY_ROUTE_DISABLED");
  });
});
