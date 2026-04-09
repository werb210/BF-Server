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
