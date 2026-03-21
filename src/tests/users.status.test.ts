import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { seedAdminUser, SEEDED_ADMIN_PHONE } from "../db/seed";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";
import { ensureAuditEventSchema } from "../__tests__/helpers/auditSchema";

const app = buildAppWithApiRoutes();

async function resetDb(): Promise<void> {
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedAdminUser();
});

afterAll(async () => {
  await pool.end();
});

describe("user enable/disable", () => {
  it("sets user status to INACTIVE and back to ACTIVE", async () => {
    const adminLogin = await otpVerifyRequest(app, { phone: SEEDED_ADMIN_PHONE });
    expect(adminLogin.status).toBe(200);

    const user = await createUserAccount({
      phoneNumber: "+14155550088",
      role: ROLES.STAFF,
    });
    await pool.query(
      "update users set active = true, is_active = true, disabled = false, status = 'ACTIVE' where id = $1",
      [user.id]
    );

    const disable = await request(app)
      .post(`/api/users/${user.id}/disable`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .send({});

    expect(disable.status).toBe(200);

    const disabledRow = await pool.query<{ status: string }>(
      "select status from users where id = $1",
      [user.id]
    );
    expect(disabledRow.rows[0]?.status).toBe("INACTIVE");

    const enable = await request(app)
      .post(`/api/users/${user.id}/enable`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .send({});

    expect(enable.status).toBe(200);

    const enabledRow = await pool.query<{ status: string }>(
      "select status from users where id = $1",
      [user.id]
    );
    expect(enabledRow.rows[0]?.status).toBe("ACTIVE");
  });
});
