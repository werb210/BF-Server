import { loadTestEnv } from "./utils/testEnv";
import { resetRedisMock } from "../src/lib/redis";

loadTestEnv();

beforeEach(() => {
  resetRedisMock();
});
