import { beforeEach } from "vitest";
import { resetRedisMock } from "../lib/redis";
import { resetTestDb } from "../lib/dbTestUtils";
import { resetOtpStateForTests } from "../modules/auth/auth.routes";
import { resetRateLimitForTests } from "../system/rateLimit";

beforeEach(async () => {
  await resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
  resetRateLimitForTests();
});
