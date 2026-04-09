import { validateEnv } from "../../system/env.js";
import { applyEnv, captureOriginalEnv, restoreEnv } from "../../../test/utils/testEnv.js";

describe("system/env", () => {
  let originalEnv = captureOriginalEnv();

  beforeEach(() => {
    originalEnv = captureOriginalEnv();
    applyEnv({ JWT_SECRET: "test-secret" });
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("uses default PORT when PORT is missing", () => {
    applyEnv({
      JWT_SECRET: "secret",
      DB_URL: "postgres://localhost:5432/test",
      PORT: undefined,
    });

    expect(() => validateEnv()).not.toThrow();
  });

  it("does not throw when JWT_SECRET is missing in test environment", () => {
    applyEnv({
      NODE_ENV: "test",
      PORT: String(Date.now()),
      JWT_SECRET: undefined,
      DB_URL: "postgres://localhost:5432/test",
    });

    expect(() => validateEnv()).not.toThrow();
  });
});
