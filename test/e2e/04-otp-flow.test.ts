import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { clearJwtSecretForAuthFailure } from "../utils/testEnv";

describe("OTP flows", () => {
  let app: Express;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    app = createServer();
  });

  it("starts OTP flow", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("verifies OTP and returns a token", async () => {
    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it("rejects invalid OTP payload", async () => {
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "bad-phone", code: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("returns unauthorized when JWT secret is unavailable", async () => {
    clearJwtSecretForAuthFailure();

    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 410 when OTP is expired", async () => {
    const startTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(startTime);

    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    nowSpy.mockReturnValue(startTime + (5 * 60 * 1000) + 1);

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "123456" });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("OTP expired");

    nowSpy.mockRestore();
  });
});
