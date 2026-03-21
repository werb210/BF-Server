import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { ROLES } from "../src/auth/roles";
import { signAccessToken } from "../src/auth/jwt";

const app = buildAppWithApiRoutes();
const requestId = "lender-contracts-test";
let phoneCounter = 9100;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query(
    "delete from users where id <> '00000000-0000-0000-0000-000000000001'"
  );
}

async function createAdminToken(): Promise<string> {
  const userId = randomUUID();
  const phone = nextPhone();
  await pool.query(
    `insert into users (
      id,
      email,
      phone_number,
      phone,
      role,
      status,
      active,
      is_active,
      disabled,
      phone_verified
    )
    values ($1, $2, $3, $4, $5, 'ACTIVE', true, true, false, true)`,
    [
      userId,
      `lender-contracts-${phone}@example.com`,
      phone,
      phone,
      ROLES.ADMIN,
    ]
  );
  const { rows } = await pool.query<{ token_version: number }>(
    "select token_version from users where id = $1",
    [userId]
  );
  return signAccessToken({
    sub: userId,
    role: ROLES.ADMIN,
    tokenVersion: rows[0]?.token_version ?? 0,
    silo: "default",
  });
}

async function createLender(token: string) {
  const lenderResponse = await request(app || require("../src/app").default)
    .post("/api/lenders")
    .set("Authorization", `Bearer ${token}`)
    .set("x-request-id", requestId)
    .send({
      name: "Contract Lender",
      country: "US",
      submissionMethod: "api",
      apiConfig: { endpoint: "https://api.contracts.test" },
    });

  return lenderResponse.body;
}

beforeEach(async () => {
  await resetDb();
  phoneCounter = 9100;
});

describe("lender contract integration", () => {
  it("returns lenders with country populated", async () => {
    const token = await createAdminToken();
    const lender = await createLender(token);

    const response = await request(app || require("../src/app").default)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(response.status).toBe(200);
    const match = response.body.find(
      (item: { id: string }) => item.id === lender.id
    );
    expect(match).toBeDefined();
    expect(match.country).toBe("US");
  });

  it("accepts empty required_documents arrays", async () => {
    const token = await createAdminToken();
    const lender = await createLender(token);

    const response = await request(app || require("../src/app").default)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId)
      .send({ lenderId: lender.id, required_documents: [] });

    expect(response.status).toBe(201);
    expect(response.body.required_documents).toEqual([
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
    ]);
  });
});
