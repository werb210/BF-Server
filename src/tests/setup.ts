import { beforeEach } from "vitest";
import { resetRedisMock } from "../lib/redis";
import { resetTestDb } from "../lib/dbTestUtils";
import { resetOtpStateForTests } from "../routes/auth/otp";
import { resetRateLimitForTests } from "../system/rateLimit";

beforeEach(async () => {
  await resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
  resetRateLimitForTests();
});
