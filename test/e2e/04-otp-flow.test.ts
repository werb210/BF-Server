import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { resetOtpStateForTests } from "../../src/routes/auth.routes";
import { clearJwtSecretForAuthFailure } from "../utils/testEnv";

describe("OTP flows", () => {
  let app: Express;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    resetOtpStateForTests();
    app = createServer();
  });

  it("starts OTP flow", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("verifies OTP and returns a token", async () => {
    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
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
      .send({ phone: "+15555550100", code: "654321" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 410 when OTP is expired", async () => {
    const startTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(startTime);

    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    nowSpy.mockReturnValue(startTime + (5 * 60 * 1000) + 1);

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("OTP expired");

    nowSpy.mockRestore();
  });

  it("rate limits OTP start within 60 seconds", async () => {
    const startTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(startTime);

    const first = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    const second = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("Too many requests");

    nowSpy.mockRestore();
  });

  it("deletes OTP after too many invalid verify attempts", async () => {
    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/auth/otp/verify")
        .send({ phone: "+15555550100", code: "000000" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid code");
    }

    const locked = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "000000" });
    expect(locked.status).toBe(400);
    expect(locked.body.error).toBe("Invalid code");

    const afterDelete = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(afterDelete.status).toBe(400);
    expect(afterDelete.body.error).toBe("Invalid code");
  });

  it("prevents OTP replay after successful verification", async () => {
    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+15555550100" });

    const first = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+15555550100", code: "654321" });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("Invalid code");
  });
});
