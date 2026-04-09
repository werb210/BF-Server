import { runQuery } from "../lib/db.js";
import { captureOriginalEnv, restoreEnv, unsetEnv } from "../../test/utils/testEnv.js";

describe("test db integration", () => {
  let originalEnv = captureOriginalEnv();

  beforeEach(() => {
    originalEnv = captureOriginalEnv();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  test("fails hard when db pool is not initialized", async () => {
    unsetEnv(["DATABASE_URL"]);
    await expect(runQuery("SELECT 1")).rejects.toThrow("DB_POOL_NOT_INITIALIZED");
  });

  test("rejects invalid queries early", async () => {
    await expect(runQuery("   ")).rejects.toThrow(/non-empty SQL query string/i);
    await expect(runQuery("SELECT $1::text", [undefined])).rejects.toThrow(
      /must not include undefined/i
    );
  });
});
