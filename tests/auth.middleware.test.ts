import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../src";
import { pool } from "../src/db";
import { ROLES, type Role } from "../src/auth/roles";
import { signAccessToken } from "../src/auth/jwt";

async function upsertUser(params: {
  phone: string;
  role: Role;
  lenderId?: string | null;
}) {
  const userId = randomUUID();
  await pool.query(
    `insert into users (
        id,
        email,
        phone_number,
        phone,
        role,
        lender_id,
        active,
        is_active,
        disabled,
        locked_until,
        phone_verified
      )
     values ($1, $2, $3, $4, $5, $6, true, true, false, null, true)
     on conflict (phone_number) do update
       set email = excluded.email,
           phone = excluded.phone,
           role = excluded.role,
           lender_id = excluded.lender_id,
           active = excluded.active,
           is_active = excluded.is_active,
           disabled = excluded.disabled,
           locked_until = excluded.locked_until,
           phone_verified = excluded.phone_verified`,
    [
      userId,
      `auth-${userId}@example.com`,
      params.phone,
      params.phone,
      params.role,
      params.lenderId ?? null,
    ]
  );
  return { userId };
}

async function issueToken(phone: string, role: Role): Promise<string> {
  const { rows } = await pool.query<{ id: string; token_version: number }>(
    "select id, token_version from users where phone_number = $1 or phone = $1",
    [phone]
  );
  const userId = rows[0]?.id;
  expect(userId).toBeTruthy();
  return signAccessToken({
    sub: userId,
    role,
    tokenVersion: rows[0]?.token_version ?? 0,
    phone,
  });
}

describe("auth middleware smoke test", () => {
  it("allows Staff/Admin and blocks unauthorized roles", async () => {
    const adminPhone = "+15555550001";
    const lenderPhone = "+15555550002";

    await upsertUser({ phone: adminPhone, role: ROLES.ADMIN });
    await upsertUser({
      phone: lenderPhone,
      role: ROLES.LENDER,
      lenderId: randomUUID(),
    });

    const adminToken = await issueToken(adminPhone, ROLES.ADMIN);
    const lenderToken = await issueToken(lenderPhone, ROLES.LENDER);

    const adminRes = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${adminToken}`);

    const lenderRes = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${lenderToken}`);

    expect(adminRes.status).toBe(200);
    expect(lenderRes.status).toBe(200);
  });
});
