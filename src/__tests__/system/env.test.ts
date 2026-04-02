import { validateEnv } from "../../system/env";

describe("system/env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws MISSING_PORT when PORT is missing", () => {
    delete process.env.PORT;
    process.env.JWT_SECRET = "secret";
    process.env.DB_URL = "postgres://localhost:5432/test";

    expect(() => validateEnv()).toThrow("MISSING_PORT");
  });

  it("does not throw when JWT_SECRET is missing in test environment", () => {
    process.env.NODE_ENV = "test";
    process.env.PORT = String(Date.now());
    delete process.env.JWT_SECRET;
    process.env.DB_URL = "postgres://localhost:5432/test";

    expect(() => validateEnv()).not.toThrow();
  });
});
