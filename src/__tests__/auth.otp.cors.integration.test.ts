import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../app.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const STAFF_ORIGIN = "https://staff.boreal.financial";

describe("OTP CORS flow", () => {
  const app = createApp();

  it("OPTIONS /api/auth/otp/start returns 204 with expected CORS headers", async () => {
    const res = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", STAFF_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type, Authorization, X-Silo, X-Request-Id");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(STAFF_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toContain("OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toContain("X-Request-Id");
  });

  it("POST /api/auth/otp/start returns OTP start response without hanging", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .set("Origin", STAFF_ORIGIN)
      .send({ phone: "+15550009999" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.sent).toBe(true);
    expect(res.headers["access-control-allow-origin"]).toBe(STAFF_ORIGIN);
  });

  it("OTP login flow completes successfully", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .set("Origin", STAFF_ORIGIN)
      .send({ phone: "+15550008888" })
      .expect(200);

    const verifyRes = await request(app)
      .post("/api/auth/otp/verify")
      .set("Origin", STAFF_ORIGIN)
      .send({ phone: "+15550008888", code: "000000" });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.status).toBe("ok");
    expect(verifyRes.body.data.token).toBeTypeOf("string");
  });
});
