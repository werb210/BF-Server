import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "lender-products-access-test";
let phoneCounter = 8400;
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
  phoneCounter = 8400;
});

afterAll(async () => {
  await pool.end();
});

describe("lender product access", () => {
  it("limits lender users to their own products and allows admin overrides", async () => {
    const lenderA = randomUUID();
    const lenderB = randomUUID();
    await pool.query(
      `insert into lenders (id, name, country)
       values ($1, $2, $3), ($4, $5, $6)` ,
      [lenderA, "Lender A", "US", lenderB, "Lender B", "CA"]
    );

    const adminPhone = nextPhone();
    await createUserAccount({
      email: `admin-${adminPhone}@example.com`,
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });

    const lenderPhone = nextPhone();
    await createUserAccount({
      email: `lender-${lenderPhone}@example.com`,
      phoneNumber: lenderPhone,
      role: ROLES.LENDER,
      lenderId: lenderA,
    });

    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: `idem-admin-${adminPhone}`,
    });

    const lenderLogin = await otpVerifyRequest(app, {
      phone: lenderPhone,
      requestId,
      idempotencyKey: `idem-lender-${lenderPhone}`,
    });

    const lenderCreate = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({ lenderId: lenderA, name: "Lender Product" });

    expect(lenderCreate.status).toBe(201);
    expect(lenderCreate.body.lenderId).toBe(lenderA);

    const lenderCross = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({ lenderId: lenderB, name: "Cross Lender Product" });

    expect(lenderCross.status).toBe(403);

    const adminCreate = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({ lenderId: lenderB, name: "Admin Product" });

    expect(adminCreate.status).toBe(201);

    const lenderList = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${lenderLogin.body.accessToken}`)
      .set("x-request-id", requestId);

    expect(lenderList.status).toBe(200);
    expect(
      lenderList.body.every((item: { lenderId: string }) => item.lenderId === lenderA)
    ).toBe(true);

    const lenderPatch = await request(app || require("../src/app").default)
      .patch(`/api/lender-products/${adminCreate.body.id}`)
      .set("Authorization", `Bearer ${lenderLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({ name: "Blocked" });

    expect(lenderPatch.status).toBe(403);

    const adminPatch = await request(app || require("../src/app").default)
      .patch(`/api/lender-products/${adminCreate.body.id}`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({ name: "Admin Update" });

    expect(adminPatch.status).toBe(200);
    expect(adminPatch.body.name).toBe("Admin Update");
  });
});
