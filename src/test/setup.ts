process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import { afterAll, beforeAll, vi } from "vitest";
import { markReady } from "../startupState";
import { setupTestDatabase } from "./db";
import {
  getExpectedTwilioSignature,
  twilioDefaultExport,
  twilioMockState,
  validateExpressRequest,
  validateRequest,
} from "./twilioMock";

dotenv.config({ path: ".env.test" });

process.env.BASE_URL ||= "https://example.test";
process.env.PUBLIC_BASE_URL ||= "https://example.test";
process.env.JWT_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.JWT_EXPIRES_IN ||= "15m";
process.env.JWT_REFRESH_EXPIRES_IN ||= "30d";
process.env.CORS_ALLOWED_ORIGINS ||= "https://staff.boreal.financial";
process.env.RATE_LIMIT_WINDOW_MS ||= "60000";
process.env.RATE_LIMIT_MAX ||= "100";
process.env.APPINSIGHTS_CONNECTION_STRING ||= "";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "test_auth_token";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "ACtest";
process.env.TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID ?? "SKtest";
process.env.TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET ?? "test_secret";
process.env.TWILIO_API_KEY ||= process.env.TWILIO_API_KEY_SID;
process.env.TWILIO_API_SECRET ||= process.env.TWILIO_API_KEY_SECRET;
process.env.TWILIO_VERIFY_SERVICE_SID ||= "VA00000000000000000000000000000000";
process.env.TWILIO_VOICE_APP_SID ||= "AP00000000000000000000000000000000";
process.env.TWILIO_VOICE_CALLER_ID ||= "+14155550000";
process.env.VAPID_PUBLIC_KEY ||= "test-vapid-public-key";
process.env.VAPID_PRIVATE_KEY ||= "test-vapid-private-key";
process.env.VAPID_SUBJECT ||= "mailto:tests@example.com";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

vi.mock("../observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("twilio", () => ({
  default: twilioDefaultExport,
  jwt: twilioDefaultExport.jwt,
  __twilioMocks: twilioMockState,
}));

(globalThis as typeof globalThis & { __twilioMocks?: unknown }).__twilioMocks = twilioMockState;

vi.mock("twilio/lib/webhooks/webhooks", () => ({
  validateRequest,
  validateExpressRequest,
  getExpectedTwilioSignature,
}));

setupTestDatabase();

markReady();

process.on("unhandledRejection", (reason) => {
  throw reason;
});
