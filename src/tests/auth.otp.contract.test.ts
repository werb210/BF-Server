import { describe, it, expect } from 'vitest';
import request from "supertest";
import app from "../app";

describe("OTP Start Endpoint Contract", () => {
  test("returns 400 when phone is missing", async () => {
    const res = await request(app).post("/api/auth/otp/start").send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  test("returns success response with valid phone", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({
        phone: "+15551234567",
      });

    expect([200, 201]).toContain(res.status);
  });
});
