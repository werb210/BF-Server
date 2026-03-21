import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "portal-smoke-request";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-portal-${idempotencyCounter++}`;
let phoneCounter = 2100;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
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
  idempotencyCounter = 0;
  phoneCounter = 2100;
});

afterAll(async () => {
  await pool.end();
});

describe("portal smoke endpoints", () => {
  it("returns empty items for portal list endpoints", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "portal.staff@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const lendersRes = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(lendersRes.status).toBe(200);
    expect(lendersRes.body).toEqual({ items: [] });

    const productsRes = await request(app)
      .get("/api/lender-products")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(productsRes.status).toBe(200);
    expect(productsRes.body).toEqual({ items: [] });

    const applicationsRes = await request(app)
      .get("/api/portal/applications")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(applicationsRes.status).toBe(200);
    expect(applicationsRes.body).toEqual({ items: [] });

    const calendarRes = await request(app)
      .get("/api/calendar/events")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(calendarRes.status).toBe(200);
    expect(calendarRes.body).toEqual({ items: [] });
  });

  it("creates and lists lenders", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "portal.staff+lenders@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const createRes = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("Idempotency-Key", nextIdempotencyKey())
      .send({
        name: "Smoke Lender",
        country: "US",
        active: true,
        submissionMethod: "email",
        submissionEmail: "submissions@smoke-lender.com",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.name).toBe("Smoke Lender");
    expect(createRes.body.country).toBe("US");

    const listRes = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0]).toMatchObject({
      id: createRes.body.id,
      name: "Smoke Lender",
      country: "US",
      active: true,
    });
  });

  it("returns ordered pipeline stages", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "portal.staff+stages@apps.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const stagesRes = await request(app)
      .get("/api/portal/applications/stages")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(stagesRes.status).toBe(200);
    expect(stagesRes.body).toEqual([
      "RECEIVED",
      "DOCUMENTS_REQUIRED",
      "IN_REVIEW",
      "STARTUP",
      "SENT_TO_LENDER",
      "ACCEPTED",
      "DECLINED",
    ]);
  });
});
