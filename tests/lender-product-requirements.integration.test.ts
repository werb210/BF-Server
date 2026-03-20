import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "lender-product-requirements";
let phoneCounter = 9800;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_product_requirements");
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
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
    email: `requirements-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-req-${phone}`,
  });
  return login.body.accessToken as string;
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

describe("lender product requirements", () => {
  it("returns 400 for invalid lender product ids", async () => {
    const response = await request(app || require("../src/app").default).get(
      "/api/client/lender-products/invalid-id/requirements"
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: "INVALID_LENDER_PRODUCT_ID",
    });
  });

  it("returns empty requirements for valid but missing lender products", async () => {
    const missingId = randomUUID();
    const response = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${missingId}/requirements`
    );

    expect(response.status).toBe(200);
    expect(response.body.productId).toBe(missingId);
    expect(response.body.requirements).toEqual([]);
  });

  it("seeds requirements when a product is created", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Seeded Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@seeded-lender.com",
      });

    expect(lenderResponse.status).toBe(201);

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Seeded LOC",
        category: "LOC",
        term_min: 6,
        term_max: 24,
        required_documents: [],
      });

    expect(productResponse.status).toBe(201);

    const requirementsResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements`
    );

    expect(requirementsResponse.status).toBe(200);
    expect(requirementsResponse.body.requirements.length).toBeGreaterThan(0);
  });

  it("returns requirements for a valid lender product", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Requirements Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@requirements-lender.com",
      });

    expect(lenderResponse.status).toBe(201);

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Requirements LOC",
        category: "LOC",
        term_min: 6,
        term_max: 24,
        required_documents: [],
      });

    expect(productResponse.status).toBe(201);

    const requirementsResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements`
    );

    expect(requirementsResponse.status).toBe(200);
    expect(requirementsResponse.body.requirements.length).toBeGreaterThan(0);
  });

  it("returns required requirements only", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Required Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@required-lender.com",
      });

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Required LOC",
        category: "LOC",
        term_min: 6,
        term_max: 24,
        required_documents: [],
      });

    const optionalRequirement = await request(app || require("../src/app").default)
      .post(`/api/lender-products/${productResponse.body.id}/requirements`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        document_type: "void_cheque",
        required: false,
      });

    expect(optionalRequirement.status).toBe(201);

    const requirementsResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements`
    );

    expect(requirementsResponse.status).toBe(200);
    const docs = requirementsResponse.body.requirements.map(
      (req: { documentType: string }) => req.documentType
    );
    expect(docs).not.toContain("void_cheque");
  });

  it("filters conditional requirements by requested amount", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Conditional Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@conditional-lender.com",
      });

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Conditional LOC",
        category: "LOC",
        term_min: 6,
        term_max: 24,
        required_documents: [],
      });

    const conditionalRequirement = await request(app || require("../src/app").default)
      .post(`/api/lender-products/${productResponse.body.id}/requirements`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        document_type: "tax_returns",
        required: true,
        min_amount: 20000,
        max_amount: 30000,
      });

    expect(conditionalRequirement.status).toBe(201);

    const outsideResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements?requestedAmount=15000`
    );

    const outsideDocs = outsideResponse.body.requirements.map(
      (req: { documentType: string }) => req.documentType
    );
    expect(outsideDocs).not.toContain("tax_returns");

    const insideResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements?requestedAmount=25000`
    );

    const insideDocs = insideResponse.body.requirements.map(
      (req: { documentType: string }) => req.documentType
    );
    expect(insideDocs).toContain("tax_returns");
  });

  it("blocks inactive products", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Inactive Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@inactive-lender.com",
      });

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Inactive LOC",
        category: "LOC",
        active: false,
        required_documents: [],
      });

    expect(productResponse.status).toBe(201);

    const requirementsResponse = await request(app || require("../src/app").default).get(
      `/api/client/lender-products/${productResponse.body.id}/requirements`
    );

    expect(requirementsResponse.status).toBe(200);
    expect(requirementsResponse.body.requirements).toEqual([]);
  });

  it("aggregates requirements for client product filters", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Aggregation Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@aggregation-lender.com",
      });

    await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Aggregation LOC 1",
        category: "LOC",
        country: "US",
        term_min: 6,
        term_max: 24,
        required_documents: [{ type: "void_cheque" }],
      });

    await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Aggregation LOC 2",
        category: "LOC",
        country: "US",
        term_min: 6,
        term_max: 24,
        required_documents: [{ type: "government_id" }],
      });

    const response = await request(app || require("../src/app").default).get(
      "/api/client/lender-products/requirements?category=LOC&country=US&requestedAmount=12"
    );

    expect(response.status).toBe(200);
    const docs = response.body.requirements.map(
      (req: { documentType: string }) => req.documentType
    );
    expect(docs).toContain("bank_statements_6_months");
    expect(docs).toContain("void_cheque");
    expect(docs).toContain("government_id");
  });
});
