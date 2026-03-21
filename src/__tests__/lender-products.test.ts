import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { randomUUID } from "crypto";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let phoneCounter = 3300;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `lender-products-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-lender-products-${phone}`,
  });
  return login.body.accessToken as string;
}

async function loginLender(lenderId: string): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `lender-products-lender-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.LENDER,
    lenderId,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-lender-products-lender-${phone}`,
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
  phoneCounter = 3300;
});

afterAll(async () => {
  await pool.end();
});

describe("lender products", () => {
  it("creates, lists, and updates required documents", async () => {
    const token = await loginAdmin();
    const lenderResponse = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Docs Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@docs-lender.com",
      });

    const requiredDocuments = [
      { type: "bank_statements_6_months" },
      { type: "government_id" },
    ];

    const createResponse = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Documented Product",
        required_documents: requiredDocuments,
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.required_documents).toEqual([
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
      { type: "government_id", document_key: "government_id" },
    ]);

    const listResponse = await request(app)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(listResponse.status).toBe(200);
    const listed = listResponse.body.find(
      (item: { id: string }) => item.id === createResponse.body.id
    );
    expect(listed).toBeDefined();
    expect(listed.required_documents).toEqual([
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
      { type: "government_id", document_key: "government_id" },
    ]);

    const updatedDocuments = [
      { type: "tax_returns" },
      { type: "financial_statements" },
    ];

    const patchResponse = await request(app)
      .patch(`/api/lender-products/${createResponse.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ required_documents: updatedDocuments });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.required_documents).toEqual([
      { type: "tax_returns", document_key: "tax_returns" },
      { type: "financial_statements", document_key: "financial_statements" },
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
    ]);

    const listAfterPatch = await request(app)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    const patched = listAfterPatch.body.find(
      (item: { id: string }) => item.id === createResponse.body.id
    );
    expect(patched.required_documents).toEqual([
      { type: "tax_returns", document_key: "tax_returns" },
      { type: "financial_statements", document_key: "financial_statements" },
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
    ]);
  });

  it("blocks lender product creation for inactive lenders", async () => {
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

  it("enforces lender product ownership for lender users", async () => {
    const lenderId = randomUUID();
    const otherLenderId = randomUUID();
    await pool.query(
      `insert into lenders (id, name, country, submission_method, active, status, created_at, updated_at)
       values ($1, $2, $3, 'email', true, 'ACTIVE', now(), now()),
              ($4, $5, $6, 'email', true, 'ACTIVE', now(), now())`,
      [
        lenderId,
        "Lender Owner",
        "US",
        otherLenderId,
        "Other Lender",
        "US",
      ]
    );

    const lenderToken = await loginLender(lenderId);

    const createResponse = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${lenderToken}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: otherLenderId,
        name: "Owner Product",
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.lenderId).toBe(lenderId);

    const otherProductResponse = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${await loginAdmin()}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: otherLenderId,
        name: "Other Product",
      });

    const listResponse = await request(app)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${lenderToken}`)
      .set("x-request-id", requestId);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.every((item: { lenderId: string }) => item.lenderId === lenderId)).toBe(
      true
    );

    const patchResponse = await request(app)
      .patch(`/api/lender-products/${otherProductResponse.body.id}`)
      .set("Authorization", `Bearer ${lenderToken}`)
      .set("x-request-id", requestId)
      .send({ name: "Blocked Update" });

    expect(patchResponse.status).toBe(403);
  });
});
