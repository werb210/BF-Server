import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-constraint-${idempotencyCounter++}`;
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
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const adminPhone = nextPhone();
  await createUserAccount({
    email: "admin-constraint@example.com",
    phoneNumber: adminPhone,
    role: ROLES.ADMIN,
  });

  const res = await otpVerifyRequest(app, {
    phone: adminPhone,
    requestId: "admin-login",
    idempotencyKey: nextIdempotencyKey(),
  });

  return res.body.accessToken as string;
}

beforeAll(async () => {
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
  phoneCounter = 400;
});

afterAll(async () => {
  await pool.end();
});

describe("constraint enforcement", () => {
  let originalTestLogging: string | undefined;

  beforeEach(() => {
    originalTestLogging = process.env.TEST_LOGGING;
    process.env.TEST_LOGGING = "true";
  });

  afterEach(() => {
    if (originalTestLogging === undefined) {
      delete process.env.TEST_LOGGING;
    } else {
      process.env.TEST_LOGGING = originalTestLogging;
    }
  });

  it("returns a clean 4xx on unique constraint violations", async () => {
    const token = await loginAdmin();

    const first = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", "create-user-1")
      .set("Idempotency-Key", nextIdempotencyKey())
      .send({ email: "dupe@example.com", phoneNumber: nextPhone(), role: "staff" });

    expect(first.status).toBe(201);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const second = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${token}`)
        .set("x-request-id", "create-user-2")
        .set("Idempotency-Key", nextIdempotencyKey())
        .send({ email: "dupe@example.com", phoneNumber: nextPhone(), role: "staff" });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe("constraint_violation");

      const warnEvents = warnSpy.mock.calls
        .map((call) => call[0])
        .filter(Boolean)
        .map((entry) => {
          try {
            return JSON.parse(String(entry));
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      expect(
        warnEvents.some(
          (payload) =>
            payload.event === "request_error" &&
            payload.failure_reason === "constraint_violation" &&
            payload.requestId === "create-user-2" &&
            payload.route === "/api/users"
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    const count = await pool.query<{ count: number }>(
      "select count(*)::int as count from users where email = 'dupe@example.com'"
    );
    expect(count.rows[0].count).toBe(1);
  });
});
