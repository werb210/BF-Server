import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES, type Role } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "pwa-sync-test";
let phoneCounter = 9300;

const nextPhone = () => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from pwa_subscriptions");
  await pool.query("delete from pwa_notifications");
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function login(role: Role): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `pwa-sync-${phone}@example.com`,
    phoneNumber: phone,
    role,
  });
  const res = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-pwa-sync-${phone}`,
  });
  return res.body.accessToken as string;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("PWA sync replay", () => {
  it("replays allowed POST actions", async () => {
    const token = await login(ROLES.ADMIN);
    const actionId = randomUUID();

    const res = await request(app || require("../src/app").default)
      .post("/api/pwa/sync")
      .set("Authorization", `Bearer ${token}`)
      .send({
        actions: [
          {
            id: actionId,
            method: "POST",
            path: "/api/lenders",
            idempotencyKey: randomUUID(),
            body: {
              name: "Offline Lender",
              country: "US",
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("succeeded");

    const lenders = await pool.query("select * from lenders");
    expect(lenders.rowCount).toBe(1);
  });

  it("rejects unsupported paths and aborts batch", async () => {
    const token = await login(ROLES.ADMIN);
    const res = await request(app || require("../src/app").default)
      .post("/api/pwa/sync")
      .set("Authorization", `Bearer ${token}`)
      .send({
        actions: [
          {
            id: randomUUID(),
            method: "POST",
            path: "/api/auth/otp/start",
            idempotencyKey: randomUUID(),
            body: { phone: "+14155550000" },
          },
          {
            id: randomUUID(),
            method: "POST",
            path: "/api/lenders",
            idempotencyKey: randomUUID(),
            body: { name: "Skipped", country: "US" },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[1].status).toBe("skipped");
  });

  it("rejects JWT tokens in payloads", async () => {
    const token = await login(ROLES.ADMIN);
    const res = await request(app || require("../src/app").default)
      .post("/api/pwa/sync")
      .set("Authorization", `Bearer ${token}`)
      .send({
        actions: [
          {
            id: randomUUID(),
            method: "POST",
            path: "/api/lenders",
            idempotencyKey: randomUUID(),
            body: {
              name: "Lender",
              country: "US",
              accessToken: "aaa.bbb.ccc",
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error.code).toBe("jwt_not_allowed");
  });
});
