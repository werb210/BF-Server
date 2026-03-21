import { vi } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { pool } from "../../src/db";
import { ROLES, type Role } from "../../src/auth/roles";
import type { Express } from "express";

const TEST_PHONE = "+15555555111";
const JWT_PHONE = "+15555555112";

function buildTestApp(): Express {
  const { buildAppWithApiRoutes } = require("../../src/app");
  return buildAppWithApiRoutes();
}

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
    [userId, `otp-${userId}@example.com`, params.phone, params.phone, params.role]
  );
  return { userId };
}

describe("OTP verify contract", () => {
  it("returns the canonical response shape", async () => {
    const app = buildTestApp();
    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    const res = await request(app || require("../src/app").default)
      .post("/api/auth/otp/verify")
      .send({ phone: TEST_PHONE, code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty("accessToken");
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body).toHaveProperty("refreshToken");
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body).not.toHaveProperty("data");
  });

  it("returns a JWT usable for /api/auth/me", async () => {
    const app = buildTestApp();
    await upsertUser({ phone: JWT_PHONE, role: ROLES.STAFF });

    const res = await request(app || require("../src/app").default)
      .post("/api/auth/otp/verify")
      .send({ phone: JWT_PHONE, code: "123456" });

    const token = res.body.accessToken as string;

    const me = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.user.id).toBeDefined();
  });

  it("fails fast when OTP verification cannot yield a token", async () => {
    await upsertUser({ phone: TEST_PHONE, role: ROLES.ADMIN });

    let app: Express;
    vi.isolateModules(() => {
      vi.mock("../../src/modules/auth/otp.service", () => {
        const actual = vi.requireActual("../../src/modules/auth/otp.service");
        return {
          ...actual,
          verifyOtpCode: vi.fn().mockResolvedValue({
            ok: true,
            token: "",
            refreshToken: "",
            user: { id: "user-1", role: ROLES.ADMIN, email: null },
          }),
        };
      });
      const { buildAppWithApiRoutes } = require("../../src/app");
      app = buildAppWithApiRoutes();
    });

    const res = await request(app!)
      .post("/api/auth/otp/verify")
      .send({ phone: TEST_PHONE, code: "123456" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/accessToken missing/i);
  });
});
