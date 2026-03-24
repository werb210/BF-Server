import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

describe("Auth", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("should start OTP", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "1234567890" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("should verify OTP and return token", async () => {
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ otp: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeDefined();
  });
});
