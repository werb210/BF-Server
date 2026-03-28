import { loadTestEnv } from "./utils/testEnv";
import { resetRedisMock } from "../src/lib/redis";

loadTestEnv();
process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./test.db";

beforeEach(() => {
  resetRedisMock();
});
