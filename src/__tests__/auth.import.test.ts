import { describe, it, expect, vi, beforeEach } from 'vitest';
describe("startup twilio config", () => {
  it("does not throw on import when TWILIO_AUTH_TOKEN missing", async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.TWILIO_AUTH_TOKEN;

    vi.resetModules();

    const { getTwilioClient } = await import("../services/twilio");
    expect(() => getTwilioClient()).toThrow(
      "Missing required env var: TWILIO_AUTH_TOKEN"
    );

    process.env = originalEnv;
  });
});
