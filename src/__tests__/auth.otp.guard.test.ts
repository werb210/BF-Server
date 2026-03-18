import type { Express } from "express";

function buildTestApp(): Express {
  const { buildAppWithApiRoutes } = require("../app");
  return buildAppWithApiRoutes();
}

describe("OTP endpoints when Twilio disabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
    };
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails fast when Twilio env is missing", () => {
    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID"
    );
  });

  it("fails fast on OTP verify when Twilio env is missing", () => {
    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID"
    );
  });
});
