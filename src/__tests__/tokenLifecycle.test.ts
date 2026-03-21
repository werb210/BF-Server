import { describe, it, expect } from 'vitest';
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { ROLES } from "../auth/roles";
import { pool } from "../db";
import { resetLoginRateLimit } from "../middleware/rateLimit";
import { createUserAccount } from "../modules/auth/auth.service";
import { otpVerifyRequest } from "./helpers/otpAuth";
import { getTwilioMocks } from "./helpers/twilioMocks";

describe("token lifecycle stability", () => {
  let app: ReturnType<typeof buildAppWithApiRoutes>;
  let phoneCounter = 400;

  const nextPhone = (): string =>
    `+1415555${String(phoneCounter++).padStart(4, "0")}`;

  async function resetDb(): Promise<void> {
    await pool.query("delete from client_submissions");
    await pool.query("delete from lender_submission_retries");
    await pool.query("delete from lender_submissions");
    await pool.query("delete from document_version_reviews");
    await pool.query("delete from document_versions");
    await pool.query("delete from documents");
    await pool.query("delete from applications");
    await pool.query("delete from idempotency_keys");
    await pool.query("delete from otp_verifications");
    await pool.query("delete from password_resets");
    await pool.query("delete from audit_events");
    await pool.query(
      "delete from users where id <> '00000000-0000-0000-0000-000000000001'"
    );
  }

  beforeAll(async () => {
    process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
    process.env.COMMIT_SHA = "test-commit";
    process.env.JWT_SECRET = "test-access-secret";
    process.env.NODE_ENV = "test";
    app = buildAppWithApiRoutes();
  });

  beforeEach(async () => {
    await resetDb();
    resetLoginRateLimit();
    phoneCounter = 400;
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockReset();
    twilioMocks.createVerificationCheck.mockReset();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("allows a grace window for /api/auth/me on expired tokens", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: "grace-user",
        role: ROLES.STAFF,
        tokenVersion: 0,
        exp: nowSeconds - 30,
        iat: nowSeconds - 60,
      },
      process.env.JWT_SECRET ?? "test-access-secret",
      {
        noTimestamp: true,
        issuer: "boreal-staff-server",
        audience: "boreal-staff-portal",
      }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe("grace-user");
    expect(res.body.silo).toBe("BF");
  });

  it("rejects expired tokens outside the grace window", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: "expired-user",
        role: ROLES.STAFF,
        tokenVersion: 0,
        exp: nowSeconds - 600,
        iat: nowSeconds - 660,
      },
      process.env.JWT_SECRET ?? "test-access-secret",
      {
        noTimestamp: true,
        issuer: "boreal-staff-server",
        audience: "boreal-staff-portal",
      }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it("returns a token on repeated OTP verify requests", async () => {
    const phone = nextPhone();
    await createUserAccount({
      email: "otp-lifecycle@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({
      status: "approved",
      sid: "VE-CHECK-LIFECYCLE",
    });

    const first = await otpVerifyRequest(app, { phone });
    expect(first.status).toBe(200);

    const twilioError = new Error("not found") as Error & {
      code?: number;
      status?: number;
    };
    twilioError.code = 20404;
    twilioError.status = 404;
    twilioMocks.createVerificationCheck.mockRejectedValueOnce(twilioError);

    const second = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone, code: "123456" });

    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.accessToken).toBeTruthy();
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(twilioMocks.createVerificationCheck).toHaveBeenCalledTimes(1);
  });
});
