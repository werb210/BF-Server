import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES, type Role } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "pwa-subscriptions-test";
let phoneCounter = 9100;

const nextPhone = () => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from pwa_subscriptions");
  await pool.query("delete from pwa_notifications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function login(role: Role): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `pwa-${phone}@example.com`,
    phoneNumber: phone,
    role,
  });
  const res = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-pwa-${phone}`,
  });
  return res.body.accessToken as string;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("PWA subscriptions", () => {
  it("creates, lists, and removes a subscription", async () => {
    const token = await login(ROLES.ADMIN);
    const endpoint = `https://example.com/push/${randomUUID()}`;

    const subscribe = await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        endpoint,
        keys: { p256dh: "key", auth: "auth" },
        deviceType: "desktop",
      });

    expect(subscribe.status).toBe(201);
    expect(subscribe.body.subscription.endpoint).toBe(endpoint);

    const list = await request(app || require("../src/app").default)
      .get("/api/pwa/subscriptions")
      .set("Authorization", `Bearer ${token}`);

    expect(list.status).toBe(200);
    expect(list.body.subscriptions).toHaveLength(1);

    const remove = await request(app || require("../src/app").default)
      .delete("/api/pwa/unsubscribe")
      .set("Authorization", `Bearer ${token}`)
      .send({ endpoint });

    expect(remove.status).toBe(200);
    expect(remove.body.removed).toBe(true);
  });

  it("enforces unique endpoint constraint across users", async () => {
    const adminToken = await login(ROLES.ADMIN);
    const staffToken = await login(ROLES.STAFF);
    const endpoint = `https://example.com/push/${randomUUID()}`;

    const first = await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        endpoint,
        keys: { p256dh: "key", auth: "auth" },
        deviceType: "mobile",
      });

    expect(first.status).toBe(201);

    const second = await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        endpoint,
        keys: { p256dh: "key2", auth: "auth2" },
        deviceType: "desktop",
      });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("endpoint_in_use");
  });
});
