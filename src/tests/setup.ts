process.env.DB_CONNECTION_STRING = "postgres://test:test@localhost:5432/test";
process.env.TWILIO_ACCOUNT_SID = "test";
process.env.TWILIO_API_KEY = "test";
process.env.TWILIO_API_SECRET = "test";
process.env.TWILIO_APP_SID = "test";

import { afterEach, beforeEach, vi } from "vitest";
import { resetRedisMock } from "../lib/redis.js";
import { resetTestDb } from "../lib/dbTestUtils.js";
import { resetOtpStateForTests } from "../app.js";
import { resetRateLimitForTests } from "../system/rateLimit.js";

beforeEach(async () => {
  await resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
  resetRateLimitForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});
