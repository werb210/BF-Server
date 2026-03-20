import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "lender-products-api-test";
let phoneCounter = 7200;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `lender-products-api-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-lender-products-api-${phone}`,
  });
  return login.body.accessToken as string;
}

async function createLender(token: string) {
  const lenderResponse = await request(app || require("../src/app").default)
    .post("/api/lenders")
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId)
    .send({
      name: "Test Lender",
      country: "US",
      submissionMethod: "email",
      submissionEmail: "submissions@test-lender.com",
    });

  return lenderResponse.body;
}

beforeAll(async () => {
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 7200;
});

describe("lender products API", () => {
  it("defaults new lenders to ACTIVE status", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    expect(lender.status).toBe("ACTIVE");
  });

  it("blocks product creation for inactive lenders", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    await pool.query(
      "update lenders set status = 'INACTIVE', active = false where id = $1",
      [lender.id]
    );

    const response = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, required_documents: [] });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Lender must be active to add products.");
  });

  it("creates and defaults product names", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    const defaultResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, required_documents: [] });

    expect(defaultResponse.status).toBe(201);
    expect(defaultResponse.body.name).toBe("Unnamed Product");

    const namedResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        lenderId: lender.id,
        name: "  Exact Product  ",
        required_documents: [],
      });

    expect(namedResponse.status).toBe(201);
    expect(namedResponse.body.name).toBe("Exact Product");
  });

  it("updates cleared names to the default", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    const createResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, name: "Named Product", required_documents: [] });

    expect(createResponse.status).toBe(201);

    const patchResponse = await request(app || require("../src/app").default)
      .patch(`/api/lender-products/${createResponse.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ name: "   ", required_documents: [] });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.name).toBe("Unnamed Product");
  });

  it("returns lender products with non-null names", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, required_documents: [] });

    const listResponse = await request(app || require("../src/app").default)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body)).toBe(true);
    const items = listResponse.body as Array<{ name: string }>;
    items.forEach((item) => {
      expect(typeof item.name).toBe("string");
      expect(item.name.length).toBeGreaterThan(0);
    });
  });

  it("returns lender details with joined products", async () => {
    const token = await loginAdmin();
    const lender = await createLender(token);

    const createResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, required_documents: [] });

    expect(createResponse.status).toBe(201);

    const joinResponse = await request(app || require("../src/app").default)
      .get(`/api/lenders/${lender.id}/products`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(joinResponse.status).toBe(200);
    expect(joinResponse.body.lender.id).toBe(lender.id);
    expect(Array.isArray(joinResponse.body.products)).toBe(true);
    const joined = joinResponse.body.products.find(
      (item: { id: string }) => item.id === createResponse.body.id
    );
    expect(joined).toBeDefined();
    expect(joined.name).toBe("Unnamed Product");
  });
});
