import { describe, it, expect, vi, beforeEach } from 'vitest';
describe("startup without Twilio configuration", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("fails fast when Twilio env vars are missing", async () => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    await expect(import("../index")).rejects.toThrow(
      "Missing required environment variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID"
    );
  });
});
