import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../src/app";
import { pool } from "../src/db";
import { createUserAccount } from "../src/modules/auth/auth.service";
import { ROLES, type Role } from "../src/auth/roles";
import { otpVerifyRequest } from "../src/__tests__/helpers/otpAuth";
import { sendNotification } from "../src/services/pushService";

vi.mock("web-push");

const webPushMock = vi.requireMock("web-push") as {
  sendNotification: vi.Mock;
};

const app = buildAppWithApiRoutes();
const requestId = "pwa-push-test";
let phoneCounter = 9200;

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
    email: `pwa-push-${phone}@example.com`,
    phoneNumber: phone,
    role,
  });
  const res = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-pwa-push-${phone}`,
  });
  return res.body.accessToken as string;
}

beforeEach(async () => {
  await resetDb();
  webPushMock.sendNotification.mockReset();
});

afterAll(async () => {
  await pool.end();
});

describe("PWA push dispatch", () => {
  it("sends notifications and writes audit logs", async () => {
    const token = await login(ROLES.ADMIN);
    const endpoint = `https://example.com/push/${randomUUID()}`;

    await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        endpoint,
        keys: { p256dh: "key", auth: "auth" },
        deviceType: "desktop",
      });

    webPushMock.sendNotification.mockResolvedValueOnce({ statusCode: 201 });

    const adminUserId = (
      await pool.query<{ id: string }>("select id from users where role = 'Admin' limit 1")
    ).rows[0].id;

    const actual = await sendNotification(
      { userId: adminUserId, role: ROLES.ADMIN },
      {
        type: "alert",
      title: "Hello",
      body: "World",
      level: "normal",
      sound: false,
      }
    );

    expect(actual.sent).toBe(1);

    const audit = await pool.query("select * from pwa_notifications");
    expect(audit.rowCount).toBe(1);
  });

  it("removes expired subscriptions on failure", async () => {
    const token = await login(ROLES.ADMIN);
    const endpoint = `https://example.com/push/${randomUUID()}`;

    await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        endpoint,
        keys: { p256dh: "key", auth: "auth" },
        deviceType: "desktop",
      });

    webPushMock.sendNotification.mockRejectedValueOnce({ statusCode: 410 });

    const adminUserId = (
      await pool.query<{ id: string }>("select id from users where role = 'Admin' limit 1")
    ).rows[0].id;

    const result = await sendNotification(
      { userId: adminUserId, role: ROLES.ADMIN },
      {
        type: "alert",
      title: "Expired",
      body: "Gone",
      level: "high",
      sound: false,
      }
    );

    expect(result.failed).toBe(1);

    const subscriptions = await pool.query("select * from pwa_subscriptions");
    expect(subscriptions.rowCount).toBe(0);
  });

  it("returns failed counts without dropping valid subscriptions", async () => {
    const token = await login(ROLES.ADMIN);
    const endpoint = `https://example.com/push/${randomUUID()}`;

    await request(app || require("../src/app").default)
      .post("/api/pwa/subscribe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        endpoint,
        keys: { p256dh: "key", auth: "auth" },
        deviceType: "desktop",
      });

    webPushMock.sendNotification.mockRejectedValueOnce({ statusCode: 500 });

    const adminUserId = (
      await pool.query<{ id: string }>("select id from users where role = 'Admin' limit 1")
    ).rows[0].id;

    const result = await sendNotification(
      { userId: adminUserId, role: ROLES.ADMIN },
      {
        type: "alert",
        title: "Retry",
        body: "Please retry",
        level: "normal",
        sound: false,
      }
    );

    expect(result.failed).toBe(1);

    const subscriptions = await pool.query("select * from pwa_subscriptions");
    expect(subscriptions.rowCount).toBe(1);
  });
});
