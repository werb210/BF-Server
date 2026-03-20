import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES, type Role } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { signAccessToken } from "../src/auth/jwt";

const app = buildAppWithApiRoutes();
let phoneCounter = 8600;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query(
    "delete from users where id <> '00000000-0000-0000-0000-000000000001'"
  );
}

async function createUserWithToken(params: {
  role: Role;
  lenderId?: string | null;
}) {
  const phoneNumber = nextPhone();
  const user = await createUserAccount({
    email: `seed-${phoneNumber}@example.com`,
    phoneNumber,
    role: params.role,
    lenderId: params.lenderId ?? null,
  });
  await pool.query(
    `update users
     set status = 'ACTIVE',
         active = true,
         is_active = true,
         disabled = false
     where id = $1`,
    [user.id]
  );
  const { rows } = await pool.query<{ token_version: number }>(
    "select token_version from users where id = $1",
    [user.id]
  );
  const tokenVersion = rows[0]?.token_version ?? 0;
  const accessToken = signAccessToken({
    sub: user.id,
    role: params.role,
    tokenVersion,
    phone: phoneNumber,
  });
  return { ...user, phoneNumber, accessToken };
}

async function seedScenario() {
  const lenderAId = randomUUID();
  const lenderBId = randomUUID();
  await pool.query(
    `insert into lenders (id, name, country, submission_method, active, status, created_at, updated_at)
     values ($1, $2, $3, 'email', true, 'ACTIVE', now(), now()),
            ($4, $5, $6, 'email', true, 'ACTIVE', now(), now())`,
    [lenderAId, "Lender A", "US", lenderBId, "Lender B", "CA"]
  );

  const admin = await createUserWithToken({ role: ROLES.ADMIN });
  const staff = await createUserWithToken({ role: ROLES.STAFF });
  const lenderUser = await createUserWithToken({
    role: ROLES.LENDER,
    lenderId: lenderAId,
  });
  const referrer = await createUserWithToken({ role: ROLES.REFERRER });

  await pool.query(
    `insert into lender_products (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MONTHS', true, '[]'::jsonb, now(), now()),
            ($11, $2, $12, $13, $14, $15, $16, $17, $18, $19, 'MONTHS', true, '[]'::jsonb, now(), now()),
            ($20, $21, $22, $23, $24, $25, $26, $27, $28, $29, 'MONTHS', true, '[]'::jsonb, now(), now())`,
    [
      randomUUID(),
      lenderAId,
      "Lender A Term",
      "TERM",
      "US",
      "FIXED",
      "8.0",
      "12.0",
      12,
      60,
      randomUUID(),
      "Lender A LOC",
      "LOC",
      "US",
      "VARIABLE",
      "Prime + 2",
      "Prime + 4",
      6,
      24,
      randomUUID(),
      lenderBId,
      "Lender B Term",
      "TERM",
      "CA",
      "FIXED",
      "7.5",
      "11.5",
      12,
      48,
    ]
  );

  return { lenderAId, lenderBId, admin, staff, lenderUser, referrer };
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  process.env.JWT_EXPIRES_IN = "15m";
  process.env.JWT_REFRESH_EXPIRES_IN = "30d";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 8600;
});

afterAll(async () => {
  await pool.end();
});

describe("codex users/lenders/lender products access", () => {
  it("enforces user role controls for users and lender creation", async () => {
    const { admin, staff, lenderUser, referrer } = await seedScenario();

    const adminUsers = await request(app || require("../src/app").default)
      .get("/api/users")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminUsers.status).toBe(200);
    expect(adminUsers.body.ok).toBe(true);

    const staffUsers = await request(app || require("../src/app").default)
      .get("/api/users")
      .set("Authorization", `Bearer ${staff.accessToken}`);
    expect(staffUsers.status).toBe(403);
    expect(staffUsers.body.error).toBe("forbidden");

    const lenderUsers = await request(app || require("../src/app").default)
      .get("/api/users")
      .set("Authorization", `Bearer ${lenderUser.accessToken}`);
    expect(lenderUsers.status).toBe(403);

    const referrerUsers = await request(app || require("../src/app").default)
      .get("/api/users")
      .set("Authorization", `Bearer ${referrer.accessToken}`);
    expect(referrerUsers.status).toBe(403);

    const createLender = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        name: "New Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@new-lender.com",
      });
    expect(createLender.status).toBe(201);

    const { rows } = await pool.query<{ id: string }>(
      "select id from lenders where id = $1",
      [createLender.body.id]
    );
    expect(rows.length).toBe(1);

    const staffCreateAdmin = await request(app || require("../src/app").default)
      .post("/api/users")
      .set("Authorization", `Bearer ${staff.accessToken}`)
      .send({
        email: "attempt-admin@example.com",
        phoneNumber: nextPhone(),
        role: ROLES.ADMIN,
      });
    expect(staffCreateAdmin.status).toBe(403);
  });

  it("scopes lender access to owned lenders for lender users", async () => {
    const { lenderAId, lenderBId, admin, staff, lenderUser } =
      await seedScenario();

    const lenderAResponse = await request(app || require("../src/app").default)
      .get(`/api/lenders/${lenderAId}/products`)
      .set("Authorization", `Bearer ${lenderUser.accessToken}`);
    expect(lenderAResponse.status).toBe(200);
    expect(lenderAResponse.body.lender.id).toBe(lenderAId);

    const lenderBResponse = await request(app || require("../src/app").default)
      .get(`/api/lenders/${lenderBId}/products`)
      .set("Authorization", `Bearer ${lenderUser.accessToken}`);
    expect(lenderBResponse.status).toBe(403);

    const adminList = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: lenderAId })])
    );

    const staffList = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${staff.accessToken}`);
    expect(staffList.status).toBe(200);
    expect(staffList.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: lenderBId })])
    );
  });

  it("controls lender product visibility by role", async () => {
    const { lenderAId, admin, lenderUser, referrer } = await seedScenario();

    const lenderProducts = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${lenderUser.accessToken}`);
    expect(lenderProducts.status).toBe(200);
    expect(
      lenderProducts.body.every(
        (product: { lenderId: string }) => product.lenderId === lenderAId
      )
    ).toBe(true);

    const adminProducts = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminProducts.status).toBe(200);
    expect(adminProducts.body).toHaveLength(3);

    const referrerProducts = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${referrer.accessToken}`);
    expect(referrerProducts.status).toBe(403);
  });

  it("enforces lender product creation rules and hard failures", async () => {
    const { lenderAId, lenderBId, admin, lenderUser } = await seedScenario();

    const lenderCreate = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderUser.accessToken}`)
      .send({ lenderId: lenderAId, name: "Lender A Product" });
    expect(lenderCreate.status).toBe(201);
    expect(lenderCreate.body.lenderId).toBe(lenderAId);

    const lenderCreatedRows = await pool.query<{ lender_id: string }>(
      "select lender_id from lender_products where id = $1",
      [lenderCreate.body.id]
    );
    expect(lenderCreatedRows.rows[0]?.lender_id).toBe(lenderAId);

    const lenderCross = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderUser.accessToken}`)
      .send({ lenderId: lenderBId, name: "Cross Lender" });
    expect(lenderCross.status).toBe(403);

    const adminCreate = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ lenderId: lenderBId, name: "Admin Product" });
    expect(adminCreate.status).toBe(201);
    expect(adminCreate.body.lenderId).toBe(lenderBId);

    const lenderMissing = await createUserWithToken({
      role: ROLES.LENDER,
      lenderId: lenderAId,
    });
    await pool.query("update users set lender_id = null where id = $1", [
      lenderMissing.id,
    ]);

    const missingBinding = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderMissing.accessToken}`)
      .send({ name: "Missing Lender" });
    expect(missingBinding.status).toBe(400);
  });
});
