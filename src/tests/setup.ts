import { beforeEach } from "vitest";
import { resetRedisMock } from "../lib/redis";
import { resetTestDb } from "../lib/db.test";
import { resetOtpStateForTests } from "../modules/auth/auth.routes";

beforeEach(async () => {
  await resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
});
