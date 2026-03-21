import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { ensureAuditEventSchema } from "../__tests__/helpers/auditSchema";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

type LogEntry = {
  level: "info" | "warn" | "error";
  payload: Record<string, unknown>;
};

function captureLogs(): {
  entries: LogEntry[];
  restore: () => void;
} {
  const entries: LogEntry[] = [];
  const infoSpy = vi.spyOn(console, "info").mockImplementation((message) => {
    entries.push({ level: "info", payload: JSON.parse(String(message)) });
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((message) => {
    entries.push({ level: "warn", payload: JSON.parse(String(message)) });
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    entries.push({ level: "error", payload: JSON.parse(String(message)) });
  });

  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

const app = buildAppWithApiRoutes();
const requestId = "sql-trace-test";
let phoneCounter = 5100;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from lender_products");
  await pool.query("delete from lenders");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `sql-trace-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-sql-trace-${phone}`,
  });
  return login.body.accessToken as string;
}

describe("sql trace logging", () => {
  let originalTestLogging: string | undefined;

  beforeAll(async () => {
    await ensureAuditEventSchema();
  });

  beforeEach(async () => {
    originalTestLogging = process.env.TEST_LOGGING;
    process.env.TEST_LOGGING = "true";
    await resetDb();
  });

  afterEach(() => {
    if (originalTestLogging === undefined) {
      delete process.env.TEST_LOGGING;
    } else {
      process.env.TEST_LOGGING = originalTestLogging;
    }
  });

  it("logs SQL queries for /api/lenders requests", async () => {
    const token = await loginAdmin();
    const { entries, restore } = captureLogs();

    const response = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    restore();

    expect(response.status).toBe(200);

    const sqlEntries = entries.filter(
      (entry) => entry.payload.event === "sql_trace_query"
    );
    expect(sqlEntries.length).toBeGreaterThan(0);

    const sqlEntry = sqlEntries.find(
      (entry) => entry.payload.path === "/api/lenders"
    );
    expect(sqlEntry?.payload.requestId).toBe(requestId);
    expect(typeof sqlEntry?.payload.sql).toBe("string");
    expect(sqlEntry?.payload.sql).toMatch(/select/i);
    expect(typeof sqlEntry?.payload.stack).toBe("string");
    expect(String(sqlEntry?.payload.stack)).toContain("sql-trace");
  });
});
