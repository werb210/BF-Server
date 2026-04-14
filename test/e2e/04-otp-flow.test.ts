import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { resetOtpStateForTests } from "../../src/app";
import { applyEnv, captureOriginalEnv, restoreEnv } from "../utils/testEnv";

describe("OTP flows", () => {
  let app: Express;
  let originalEnv = captureOriginalEnv();

  beforeEach(() => {
    originalEnv = captureOriginalEnv();
    applyEnv({
      JWT_SECRET: "test-secret",
    });
    resetOtpStateForTests();
    app = createServer();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("starts OTP flow", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data).toEqual({ sent: true });
  });

  it("verifies OTP and returns a token", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.data?.token).toBe("string");
  });

  it("rejects wrong OTP code", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550101" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550101", code: "654321" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid code");
  });

  it("rejects invalid OTP payload", async () => {
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "bad-phone", code: "abc" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid code");
  });

  it("returns token when JWT secret is unavailable", async () => {
    applyEnv({ JWT_SECRET: undefined });

    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.data?.token).toBe("string");
  });

  it("does not return 405 for canonical OTP routes", async () => {
    const startRes = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });
    expect(startRes.status).not.toBe(405);

    const verifyRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(verifyRes.status).not.toBe(405);
  });

  it("returns invalid code when OTP has not been stored", async () => {
    const startTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(startTime);

    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    nowSpy.mockReturnValue(startTime + (5 * 60 * 1000) + 1);

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid code");

    nowSpy.mockRestore();
  });

  it("allows repeated OTP start requests in test mode", async () => {
    const startTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(startTime);

    const first = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const second = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("ok");
    expect(second.body.data).toEqual({ sent: true });

    nowSpy.mockRestore();
  });

  it("allows valid OTP after invalid verify attempts", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/api/auth/otp/verify")
        .send({ phone: "+15555550100", code: "654321" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid code");
    }

    const locked = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe("Invalid code");

    const afterInvalidAttempts = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(afterInvalidAttempts.status).toBe(200);
    expect(afterInvalidAttempts.body.status).toBe("ok");
    expect(typeof afterInvalidAttempts.body.data?.token).toBe("string");
  });

  it("allows OTP replay after successful verification", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const first = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("ok");
    expect(typeof replay.body.data?.token).toBe("string");
  });
});
