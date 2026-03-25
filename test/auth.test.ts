import request from "supertest";
import type { Express } from "express";
import { createServer } from "../src/server/createServer";

describe("Auth", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("should start OTP", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+12345678901" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("should verify OTP and return token", async () => {
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+12345678901", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBeDefined();
  });
});
