import { beforeEach } from "vitest";
import { resetRedisMock } from "../lib/redis";
import { resetTestDb } from "../lib/dbTestUtils";
import { resetOtpStateForTests } from "../routes/auth";
import { resetRateLimitForTests } from "../system/rateLimit";

beforeEach(async () => {
  await resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
  resetRateLimitForTests();
});
