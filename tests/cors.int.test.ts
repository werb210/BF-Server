import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { signAccessToken } from "../src/auth/jwt";
import { ROLES } from "../src/auth/roles";

const app = buildAppWithApiRoutes();
const portalOrigin = "https://staff.boreal.financial";

async function upsertAdminUser(phone: string) {
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
      `cors-${userId}@example.com`,
      phone,
      phone,
      ROLES.ADMIN,
      null,
    ]
  );
  return { userId, phone };
}

async function issueAdminToken(userId: string, phone: string): Promise<string> {
  const { rows } = await pool.query<{ token_version: number }>(
    "select token_version from users where id = $1",
    [userId]
  );
  return signAccessToken({
    sub: userId,
    role: ROLES.ADMIN,
    tokenVersion: rows[0]?.token_version ?? 0,
    phone,
  });
}

describe("cors and internal route guard", () => {
  it("allows portal origin to call /api/health", async () => {
    const res = await request(app || require("../src/app").default)
      .get("/api/health")
      .set("Origin", portalOrigin);

    expect(res.status).toBe(200);
  });

  it("blocks browser origins from /api/_int routes", async () => {
    const res = await request(app || require("../src/app").default)
      .get("/api/_int/routes")
      .set("Origin", portalOrigin);

    expect(res.status).toBe(403);
  });

  it("allows server-to-server access to /api/_int routes", async () => {
    const res = await request(app || require("../src/app").default).get("/api/_int/routes");

    expect(res.status).toBe(200);
  });

  it("keeps auth routes working with Authorization header", async () => {
    const phone = "+15555550999";
    const { userId } = await upsertAdminUser(phone);
    const token = await issueAdminToken(userId, phone);

    const res = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
