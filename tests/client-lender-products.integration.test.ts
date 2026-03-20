import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES } from "../src/auth/roles";
import { ensureAuditEventSchema } from "../src/__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "client-lender-products-integration";
let phoneCounter = 9300;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
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
    email: `client-lender-products-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-client-lender-products-${phone}`,
  });
  return login.body.accessToken as string;
}

beforeAll(async () => {
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 9300;
});

afterAll(async () => {
  await pool.end();
});

describe("client lender products flow", () => {
  it("creates a lender product and returns it to clients", async () => {
    const token = await loginAdmin();

    const lenderResponse = await request(app || require("../src/app").default)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({
        name: "Client Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@client-lender.com",
      });

    expect(lenderResponse.status).toBe(201);

    const productResponse = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .set("x-request-id", requestId)
      .send({
        lenderId: lenderResponse.body.id,
        name: "Client LOC",
        category: "LOC",
        term_min: 6,
        term_max: 24,
        required_documents: [],
      });

    expect(productResponse.status).toBe(201);

    const clientList = await request(app || require("../src/app").default).get("/api/client/lender-products");

    expect(clientList.status).toBe(200);
    expect(Array.isArray(clientList.body)).toBe(true);

    const returned = clientList.body.find(
      (item: { id: string }) => item.id === productResponse.body.id
    );
    expect(returned).toBeDefined();
    expect(returned.category).toBe("LOC");
    expect(returned.term_min).toBe(6);
    expect(returned.term_max).toBe(24);

    const statusCheck = await pool.query<{ active: boolean }>(
      "select active from lender_products where id = $1",
      [productResponse.body.id]
    );
    expect(statusCheck.rows[0]?.active).toBe(true);
  });
});
