import "./mocks/externalMocks";
import "./setup";
import { applyTestEnvDefaults } from "../test/setupEnv.js";
import { afterAll } from "vitest";
// Import-free module on purpose: nothing (config, logger, db) loads before the test's mocks.
import { setStaffUserLoader, type StaffUserRecord } from "../auth/staffUserLoaderRegistry.js";

applyTestEnvDefaults();

// BF_SERVER_v789_STAFF_USER_STATE - the staff middlewares now require a users row
// for every staff-human token. Hundreds of tests sign staff JWTs against a loosely
// mocked DB, so by default the suite synthesizes an active user from the token's
// claims (role from the claim, token_version 0). middleware/auth.ts still runs the
// profile lookup it always ran, so tests that answer `FROM users WHERE id = $1`
// with a silo / role keep seeing it. Tests of the real behaviour call
// resetStaffUserLoader() to get the database loader back.
setStaffUserLoader(
  async (userId, claims, ctx): Promise<StaffUserRecord> => {
    let row: Record<string, unknown> | null = null;
    if (ctx.profile && userId) {
      try {
        const { pool } = await import("../db.js");
        const result = await pool.query(`SELECT id, email, role, silo, silos FROM users WHERE id = $1 LIMIT 1`, [userId]);
        const first = (result as { rows?: unknown[] } | undefined)?.rows?.[0];
        row = first && typeof first === "object" ? (first as Record<string, unknown>) : null;
      } catch (err) {
        // Test default only: no reachable or mocked users table means "no profile".
        console.debug("[test staff user loader] profile lookup failed", err instanceof Error ? err.message : String(err));
      }
    }
    const rowRole = typeof row?.role === "string" && row.role ? row.role : null;
    return {
      id: userId,
      role: rowRole ?? (typeof claims.role === "string" ? claims.role : null),
      active: true,
      is_active: true,
      disabled: false,
      status: "ACTIVE",
      deleted_at: null,
      locked_until: null,
      token_version: 0,
      profile: row,
    };
  },
  { cache: false },
);

process.env.NODE_ENV = "test";
// BF_SERVER_BLOCK_v577 - the integration job provides a real Postgres (built from the schema
// baseline) in DATABASE_URL. Overwriting it with this placeholder meant no integration test ever
// reached that database. Unit runs still get the placeholder.
if (!(process.env.VITEST_INTEGRATION === "true" && process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:5432/bf_test";
}
process.env.JWT_SECRET = "test-jwt-secret";
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_API_KEY = "SK00000000000000000000000000000000";
process.env.TWILIO_API_SECRET = "test-api-secret";
process.env.REDIS_URL = "redis://127.0.0.1:6379/9";
process.env.PORT = "4000";

process.env.TWILIO_PHONE = "+10000000000";
process.env.TWILIO_VOICE_APP_SID = "AP00000000000000000000000000000000";
process.env.TEST_OTP_CODE = "123456";
process.env.SKIP_DB_CONNECTION = "true";

const originalLog = console.log;
let done = false;

console.log = (...args: unknown[]) => {
  if (done) return;
  if (args.includes("CI_TESTS_COMPLETE")) done = true;
  originalLog(...args);
};

afterAll(() => {
  if (process.env.CI_VALIDATE === "true") {
    console.log("CI_TESTS_COMPLETE");
  }
});

process.on("unhandledRejection", (err) => {
  if (String(err).toLowerCase().includes("network")) {
    throw err;
  }
});
