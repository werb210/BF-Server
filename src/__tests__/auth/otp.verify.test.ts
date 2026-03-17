import request from "supertest";
import { randomUUID } from "crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildAppWithApiRoutes } from "../../app";
import { pool } from "../../db";
import { ROLES } from "../../auth/roles";

async function insertUser(phone: string, email: string): Promise<void> {
  await pool.query(
    `insert into users (id, email, phone_number, phone, role, active, is_active, disabled, phone_verified, status, silo)
     values ($1, $2, $3, $4, $5, true, true, false, true, 'ACTIVE', 'staff')`,
    [randomUUID(), email, phone, phone, ROLES.STAFF]
  );
}

describe("POST /api/auth/otp/start and /api/auth/otp/verify", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    vi.clearAllMocks();
    await pool.query("alter table users add column if not exists silo text");
    await pool.query("alter table users add column if not exists status text");
    await pool.query("delete from auth_refresh_tokens");
    await pool.query("delete from otp_verifications");
    await pool.query("delete from otp_sessions");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("normalizes start phone (587) 888-1837 to +15878881837", async () => {
    const app = buildAppWithApiRoutes();
    const res = await request(app).post("/api/auth/otp/start").send({ phone: "(587) 888-1837" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("normalizes verify phone 5878881837 to +15878881837", async () => {
    await insertUser("+15878881837", "otp-normalize@example.com");
    const app = buildAppWithApiRoutes();
    const start = await request(app).post("/api/auth/otp/start").send({ phone: "(587) 888-1837" });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone: "5878881837", code: start.body.data?.otp ?? "123456" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("approved OTP + found user => strict success", async () => {
    const phone = "+14155551234";
    await insertUser(phone, "otp-approved@example.com");
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone: "4155551234", code: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user).toBeTruthy();
    expect(res.body.data?.nextPath).toBe("/portal");
    expect(typeof res.body.requestId).toBe("string");
  });

  it("approved OTP + missing user => user_not_found and never ok true", async () => {
    const phone = "+15875550123";
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone: "5875550123", code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  it("approved OTP + token creation failure => auth_token_creation_failed", async () => {
    const phone = "+14155550999";
    await insertUser(phone, "otp-token-fail@example.com");
    process.env.JWT_SECRET = "";
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  it("invalid OTP => invalid_otp", async () => {
    const phone = "+14155557654";
    await insertUser(phone, "otp-invalid@example.com");
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  it("expired/missing OTP session => explicit error", async () => {
    const phone = "+14155550022";
    await insertUser(phone, "otp-expired@example.com");
    const app = buildAppWithApiRoutes();
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBeDefined();
  });

  it("never returns ok true with null token/user", async () => {
    const phone = "+14155550023";
    await insertUser(phone, "otp-shape@example.com");
    const app = buildAppWithApiRoutes();
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "000000" });
    expect(res.body).not.toMatchObject({ ok: true, data: { token: null, user: null } });
  });

  it("expired otp session => explicit expired_code", async () => {
    const phone = "+14155550111";
    await insertUser(phone, "otp-expired-session@example.com");
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });
    await pool.query(
      `update otp_sessions set expires_at = now() - interval '1 minute' where phone = $1`,
      [phone]
    );

    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("expired_code");
  });

  it("uses latest otp_verifications row when historical approved rows exist", async () => {
    const phone = "+14155550112";
    await insertUser(phone, "otp-latest-verification@example.com");
    const app = buildAppWithApiRoutes();
    await request(app).post("/api/auth/otp/start").send({ phone });

    const userRow = await pool.query<{ id: string }>(
      `select id from users where phone_number = $1 limit 1`,
      [phone]
    );
    const userId = userRow.rows[0]?.id;
    expect(userId).toBeTruthy();

    await pool.query(
      `insert into otp_verifications (id, user_id, phone, verification_sid, status, verified_at, created_at)
       values ($1, $2, $3, null, 'approved', now() - interval '5 minute', now() - interval '5 minute')`,
      [randomUUID(), userId, phone]
    );
    await pool.query(
      `insert into otp_verifications (id, user_id, phone, verification_sid, status, verified_at, created_at)
       values ($1, $2, $3, null, 'pending', null, now())`,
      [randomUUID(), userId, phone]
    );

    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("invalid_otp");
  });

});
