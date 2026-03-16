import request from "supertest";
import type { Express } from "express";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createUserAccount } from "../../modules/auth/auth.service";
import { ROLES } from "../../auth/roles";
import { pool } from "../../db";

function buildTestApp(): Express {
  const { buildAppWithApiRoutes } = require("../../app");
  return buildAppWithApiRoutes();
}

describe("POST /api/auth/otp/verify", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
    await pool.query("delete from auth_refresh_tokens");
    await pool.query("delete from otp_verifications");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects invalid OTP codes", async () => {
    const phone = `+1415555${Math.floor(Math.random() * 9000 + 1000)}`;
    await createUserAccount({
      email: "otp-invalid@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone, code: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe("invalid_code");
  });

  it("accepts valid OTP for existing auth user with staff payload", async () => {
    const phone = `+1415555${Math.floor(Math.random() * 9000 + 1000)}`;
    await createUserAccount({
      email: "otp-approved@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const app = buildTestApp();
    await request(app).post("/api/auth/otp/start").send({ phone });
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone, code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeNull();
    expect(typeof res.body.data?.token).toBe("string");
    expect(typeof res.body.data?.sessionToken).toBe("string");
    expect(res.body.data?.user?.id).toBeTruthy();
    expect(res.body.data?.applicationId).toBeNull();
    expect(res.body.data?.nextPath).toBe("/portal");
  });

  it("accepts valid OTP without pre-existing user for applicant flow", async () => {
    const phone = `+1587${Math.floor(Math.random() * 9000000 + 1000000)}`;

    await pool.query("delete from users where phone_number = $1", [phone]);

    const app = buildTestApp();
    const startRes = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone, code: startRes.body.data?.otp ?? "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data?.token).toBeNull();
    expect(typeof res.body.data?.sessionToken).toBe("string");
    expect(res.body.data?.user).toBeNull();
    expect(res.body.data?.applicationId).toBeNull();
    expect(res.body.data?.nextPath).toBe("/application/start");
    expect(res.body.error?.code).not.toBe("user_not_found");
  });

  it("normalizes phone for OTP verify lookup", async () => {
    const phone = "+15878881837";
    await pool.query("delete from users where phone_number = $1", [phone]);

    const app = buildTestApp();
    await request(app).post("/api/auth/otp/start").send({ phone: "5878881837" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "5878881837", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeNull();
    expect(res.body.data?.nextPath).toBe("/application/start");
  });
});
