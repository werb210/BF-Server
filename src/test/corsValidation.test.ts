import { vi } from 'vitest';
import * as logger from "../observability/logger";
import { validateCorsConfig } from "../startup/corsValidation";

describe("validateCorsConfig", () => {
  let logErrorSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    logErrorSpy = vi.spyOn(logger, "logError").mockImplementation(() => {
      return;
    });
  });

  afterEach(() => {
    logErrorSpy.mockRestore();
    process.env = originalEnv;
  });

  it("does not log when all required Boreal origins are configured", () => {
    process.env.CORS_ALLOWED_ORIGINS = [
      "https://staff.boreal.financial",
      "https://portal.boreal.financial",
      "https://boreal.financial",
      "https://client.boreal.financial",
    ].join(",");

    validateCorsConfig();

    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it("logs missing required origins", () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://staff.boreal.financial";

    validateCorsConfig();

    expect(logErrorSpy).toHaveBeenCalledWith(
      "cors_validation_failed",
      expect.objectContaining({
        reason: "required_origins_missing",
        missingOrigins: [
          "https://portal.boreal.financial",
          "https://boreal.financial",
          "https://client.boreal.financial",
        ],
      })
    );
  });
});
