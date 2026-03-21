import { describe, it, expect } from 'vitest';
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../../server";
import { pool } from "../../db";
import { ROLES, type Role } from "../../auth/roles";

const TEST_PHONE = "+15555550100";

async function upsertUser(params: { phone: string; role: Role }) {
  const userId = randomUUID();
  await pool.query(
    `insert into users (
        id,
        email,
        phone_number,
        phone,
        role,
        active,
        is_active,
        disabled,
        locked_until,
        phone_verified
      )
     values ($1, $2, $3, $4, $5, true, true, false, null, true)
     on conflict (phone_number) do update
       set email = excluded.email,
           phone = excluded.phone,
           role = excluded.role,
           active = excluded.active,
           is_active = excluded.is_active,
           disabled = excluded.disabled,
           locked_until = excluded.locked_until,
           phone_verified = excluded.phone_verified`,
    [userId, `contract-${userId}@example.com`, params.phone, params.phone, params.role]
  );
  return { userId };
}

async function issueToken(phone: string): Promise<string | null> {
  const res = await request(app)
    .post("/api/auth/otp/verify")
    .send({ phone, code: "123456" });

  if (res.status === 204) {
    return null;
  }

  const token = res.body?.accessToken;
  return typeof token === "string" ? token : null;
}

describe("auth contract", () => {
  it("OTP start contract", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: TEST_PHONE });

    expect([200, 204]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("OTP verify contract", async () => {
    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: TEST_PHONE, code: "123456" });

    expect([200, 204]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body?.ok).toBe(true);
      expect(typeof res.body?.accessToken).toBe("string");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("JWT role claim", async () => {
    const phone = "+15555550101";
    await upsertUser({ phone, role: ROLES.ADMIN });

    const token = await issueToken(phone);
    expect(token).toBeTruthy();

    const decoded = jwt.verify(token!, process.env.JWT_SECRET!) as {
      role?: string;
      silo?: string;
      phone?: string;
    };

    expect(decoded.role).toBeTruthy();
    expect([ROLES.ADMIN, ROLES.STAFF]).toContain(decoded.role);
    expect(decoded.role).not.toBe(decoded.role?.toLowerCase());
    expect(decoded.silo).toBe("BF");
    expect(decoded.phone).toBe(phone);
  });

  it("auth me contract with bearer token", async () => {
    const phone = "+15555550106";
    await upsertUser({ phone, role: ROLES.STAFF });

    const token = await issueToken(phone);
    expect(token).toBeTruthy();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.role).toBe(ROLES.STAFF);
    expect(res.body.silo).toBe("BF");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("auth me contract without token", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("auth me contract with invalid token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("auth header acceptance", async () => {
    const adminPhone = "+15555550102";
    const staffPhone = "+15555550104";

    await upsertUser({ phone: adminPhone, role: ROLES.ADMIN });
    await upsertUser({ phone: staffPhone, role: ROLES.STAFF });

    const adminToken = await issueToken(adminPhone);
    const staffToken = await issueToken(staffPhone);

    expect(adminToken).toBeTruthy();
    expect(staffToken).toBeTruthy();

    const adminRes = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${adminToken}`);
    const staffRes = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${staffToken}`);

    expect(adminRes.status).toBe(200);
    expect(staffRes.status).toBe(200);
  });

  it("staff read bypass", async () => {
    const phone = "+15555550105";
    await upsertUser({ phone, role: ROLES.STAFF });

    const token = await issueToken(phone);
    expect(token).toBeTruthy();

    const res = await request(app)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
