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
    expect(res.body.success).toBe(true);
  });

  it("verifies OTP and returns a token", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.data?.token).toBe("string");
    expect(res.body.data.token.length).toBeGreaterThan(20);
  });

  it("rejects wrong OTP code", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550101" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550101", code: "000000" });

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

  it("returns unauthorized when JWT secret is unavailable", async () => {
    applyEnv({ JWT_SECRET: undefined });

    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid code");
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
      .send({ phone: "+15555550100", code: "654321" });

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
    expect(second.body.success).toBe(true);

    nowSpy.mockRestore();
  });

  it("deletes OTP after too many invalid verify attempts", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/api/auth/otp/verify")
        .send({ phone: "+15555550100", code: "000000" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid code");
    }

    const locked = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe("Invalid code");

    const afterDelete = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(afterDelete.status).toBe(401);
    expect(afterDelete.body.error).toBe("Invalid code");
  });

  it("prevents OTP replay after successful verification", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550100" });

    const first = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(first.status).toBe(401);

    const replay = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("Invalid code");
  });
});
