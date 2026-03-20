import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES, type Role } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "pwa-runtime-test";
let phoneCounter = 9400;

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
    email: `pwa-runtime-${phone}@example.com`,
    phoneNumber: phone,
    role,
  });
  const res = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-pwa-runtime-${phone}`,
  });
  return res.body.accessToken as string;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("PWA runtime endpoints", () => {
  it("returns runtime flags", async () => {
    const token = await login(ROLES.STAFF);
    const res = await request(app || require("../src/app").default)
      .get("/api/pwa/runtime")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.push_enabled).toBeDefined();
    expect(res.body.background_sync_enabled).toBe(true);
    expect(res.body.offline_replay_enabled).toBe(true);
    expect(res.body.server_version).toBeDefined();
  });

  it("returns health status", async () => {
    const token = await login(ROLES.ADMIN);
    const res = await request(app || require("../src/app").default)
      .get("/api/pwa/health")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vapid_keys_valid).toBeDefined();
    expect(res.body.db_writeable).toBeDefined();
  });
});
