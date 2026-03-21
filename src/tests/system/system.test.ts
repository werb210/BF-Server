import { describe, it, expect } from 'vitest';
import request from "supertest";
import app from "../../app";

const TEST_PHONE = "+14155550123";

describe("Boreal Full API System Test", () => {
  let token: string;

  test("Health endpoint", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  test("OTP start", async () => {
    const res = await request(app)
      .post("/api/auth/request")
      .send({ phone: TEST_PHONE });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("OTP verify", async () => {
    const res = await request(app)
      .post("/api/auth/verify")
      .send({
        phone: TEST_PHONE,
        code: "000000",
      });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    token = res.body.token;
  });

  test("Auth middleware rejects missing token", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
  });

  test("Users endpoint", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test("Lenders endpoint", async () => {
    const res = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test("Applications endpoint", async () => {
    const res = await request(app)
      .get("/api/applications")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test("Documents endpoint", async () => {
    const res = await request(app)
      .get("/api/reporting/documents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
