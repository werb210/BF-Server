import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import {
  otpStartRequest,
  otpVerifyRequest,
} from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "smoke-server-e2e";
let phoneCounter = 9800;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_product_requirements");
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

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `smoke-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });

  const startRes = await otpStartRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-otp-start-${phone}`,
  });
  expect(startRes.status).toBe(200);

  const verifyRes = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-otp-verify-${phone}`,
  });
  expect(verifyRes.status).toBe(200);

  return verifyRes.body.accessToken as string;
}

beforeAll(async () => {
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 9800;
});

afterAll(async () => {
  await pool.end();
});

describe("server smoke test", () => {
  it("covers auth, users, lenders, products, requirements, and client endpoints", async () => {
    const health = await request(app || require("../src/app").default).get("/health");
    expect(health.status).toBe(200);

    const accessToken = await loginAdmin();

    const authMe = await request(app || require("../src/app").default)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(authMe.status).toBe(200);

    const usersMe = await request(app || require("../src/app").default)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(usersMe.status).toBe(200);

    const lendersList = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(lendersList.status).toBe(200);

    const lenderCreate = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "Smoke Lender",
        country: "US",
        submissionMethod: "api",
        apiConfig: { endpoint: "https://api.smoke-server.test" },
      });
    expect(lenderCreate.status).toBe(201);

    const lenderProducts = await request(app || require("../src/app").default)
      .get(`/api/lenders/${lenderCreate.body.id}/products`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(lenderProducts.status).toBe(200);

    const productCreate = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        lenderId: lenderCreate.body.id,
        name: "Smoke Product",
        type: "loc",
        min_amount: 1000,
        max_amount: 5000,
        required_documents: [],
      });
    expect(productCreate.status).toBe(201);

    const productList = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(productList.status).toBe(200);

    const requirementCreate = await request(app || require("../src/app").default)
      .post(`/api/lender-products/${productCreate.body.id}/requirements`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        document_type: "bank_statement",
        required: true,
      });
    expect(requirementCreate.status).toBe(201);

    const requirementList = await request(app || require("../src/app").default)
      .get(`/api/lender-products/${productCreate.body.id}/requirements`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(requirementList.status).toBe(200);

    const requirementInvalid = await request(app || require("../src/app").default)
      .get("/api/lender-products/not-a-uuid/requirements")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(requirementInvalid.status).toBe(400);

    const clientLenders = await request(app || require("../src/app").default).get("/api/client/lenders");
    expect(clientLenders.status).toBe(200);

    const clientProducts = await request(app || require("../src/app").default).get("/api/client/lender-products");
    expect(clientProducts.status).toBe(200);

    const clientRequirementsValid = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productCreate.body.id}/requirements`
    );
    expect(clientRequirementsValid.status).toBe(200);

    const clientRequirementsInvalid = await request(app || require("../src/app").default).get(
      "/api/client/lender-products/not-a-uuid/requirements"
    );
    expect(clientRequirementsInvalid.status).toBe(400);
  });
});
