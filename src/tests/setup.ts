process.env.DB_CONNECTION_STRING = "postgres://test:test@localhost:5432/test";
process.env.TWILIO_ACCOUNT_SID = "test";
process.env.TWILIO_API_KEY = "test";
process.env.TWILIO_API_SECRET = "test";
process.env.TWILIO_APP_SID = "test";

import { afterEach, beforeEach, vi } from "vitest";

// BF_SERVER_v789_DEAD_CODE - this used to build a pg-mem pool nobody read, and reset
// a Redis mock and a rate-limit store that no live module uses. Those modules are gone.
beforeEach(async () => {
  // BF_SERVER_BLOCK_v571 - was resetOtpStateForTests() from ../app.js, which loaded the
  // whole route graph before each test file's vi.mock could apply. Same reset, no import.
  (globalThis as any).__otpStore = {};
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});
