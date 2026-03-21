import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "../__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "lender-products-integration";
let phoneCounter = 7300;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `lender-products-admin-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-lender-products-admin-${phone}`,
  });
  return login.body.accessToken as string;
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 7300;
});

afterAll(async () => {
  await pool.end();
});

describe("lender products integration", () => {
  it("blocks product creation for inactive lenders", async () => {
    const token = await loginAdmin();
    const inactiveLender = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Inactive Lender",
        country: "US",
        active: false,
        submissionMethod: "email",
        submissionEmail: "submissions@inactive-lender.com",
      });

    const blocked = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: inactiveLender.body.id,
        name: "Blocked Product",
        required_documents: [],
      });

    expect(blocked.status).toBe(400);

    const activeLender = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Active Lender",
        country: "US",
        active: true,
        submissionMethod: "email",
        submissionEmail: "submissions@active-lender.com",
      });

    const created = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: activeLender.body.id,
        name: "Active Product",
        required_documents: [],
      });

    expect(created.status).toBe(201);
    expect(created.body.lenderId).toBe(activeLender.body.id);
  });

  it("stores variable rate min/max as Prime + X", async () => {
    const token = await loginAdmin();
    const lenderResponse = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Variable Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@variable-lender.com",
      });

    const createResponse = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Variable Product",
        required_documents: [],
        rate_type: "VARIABLE",
        interest_min: 2.5,
        interest_max: 4.25,
      });

    expect(createResponse.status).toBe(201);

    const rateRow = await pool.query<{
      rate_type: string | null;
      interest_min: string | null;
      interest_max: string | null;
    }>(
      "select rate_type, interest_min, interest_max from lender_products where id = $1",
      [createResponse.body.id]
    );

    expect(rateRow.rows[0]).toMatchObject({
      rate_type: "VARIABLE",
      interest_min: "Prime + 2.5",
      interest_max: "Prime + 4.25",
    });
  });

  it("filters lender products by country", async () => {
    const token = await loginAdmin();
    const lenderResponse = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Country Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@country-lender.com",
      });

    await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Canada Product",
        country: "CA",
        required_documents: [],
      });

    await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Both Product",
        country: "BOTH",
        required_documents: [],
      });

    await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "US Product",
        country: "US",
        required_documents: [],
      });

    const response = await request(app)
      .get(`/api/lender-products?lenderId=${lenderResponse.body.id}&country=CA`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(response.status).toBe(200);
    const productNames = response.body.map((item: { name: string }) => item.name);
    expect(productNames).toEqual(expect.arrayContaining(["Canada Product", "Both Product"]));
    expect(productNames).not.toEqual(expect.arrayContaining(["US Product"]));
  });
});
