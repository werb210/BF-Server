import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";

describe("Route registration and prefix integrity", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("registers canonical OTP routes under /api/auth", async () => {
    const start = await request(app).post("/api/auth/otp/start").send({ phone: "+15555550100" });
    expect(start.status).not.toBe(404);
    expect(start.status).not.toBe(405);
    expect(start.status).toBeLessThan(500);

    const verify = await request(app).post("/api/auth/otp/verify").send({ phone: "+15555550100", code: "654321" });
    expect(verify.status).not.toBe(404);
    expect(verify.status).not.toBe(405);
    expect(verify.status).toBeLessThan(500);
  });

  it("does not expose legacy OTP aliases", async () => {
    const legacyStart = await request(app).post("/api/v1/auth/otp/start").send({ phone: "+15555550100" });
    expect(legacyStart.status).toBe(404);

    const legacyVerify = await request(app)
      .post("/api/v1/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(legacyVerify.status).toBe(404);

    const noApiPrefixStart = await request(app).post("/auth/otp/start").send({ phone: "+15555550100" });
    expect(noApiPrefixStart.status).toBe(404);

    const noApiPrefixVerify = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(noApiPrefixVerify.status).toBe(404);
  });
});
