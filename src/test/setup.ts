process.env.NODE_ENV = "test";

import dotenv from "dotenv";
import { vi } from "vitest";
import { markReady } from "../startupState";
import { setupTestDatabase } from "./db";

dotenv.config({ path: ".env.test" });

process.env.BASE_URL ||= "http://127.0.0.1:0";
process.env.JWT_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.JWT_EXPIRES_IN ||= "15m";
process.env.JWT_REFRESH_EXPIRES_IN ||= "30d";
process.env.CORS_ALLOWED_ORIGINS ||= "https://staff.boreal.financial";
process.env.RATE_LIMIT_WINDOW_MS ||= "60000";
process.env.RATE_LIMIT_MAX ||= "100";
process.env.APPINSIGHTS_CONNECTION_STRING ||= "";
process.env.TWILIO_ACCOUNT_SID ||= "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_AUTH_TOKEN ||= "test-auth-token-1234567890";
process.env.TWILIO_VERIFY_SERVICE_SID ||= "VA00000000000000000000000000000000";
process.env.TWILIO_API_KEY ||= "SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_API_SECRET ||= "test-twilio-api-secret";
process.env.TWILIO_VOICE_APP_SID ||= "AP00000000000000000000000000000000";
process.env.TWILIO_VOICE_CALLER_ID ||= "+14155550000";
process.env.VAPID_PUBLIC_KEY ||= "test-vapid-public-key";
process.env.VAPID_PRIVATE_KEY ||= "test-vapid-private-key";
process.env.VAPID_SUBJECT ||= "mailto:tests@example.com";

vi.mock("../observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("twilio", () => {
  const createVerification = vi.fn(async () => ({
    sid: "VE_TEST",
    status: "pending",
  }));
  const createVerificationCheck = vi.fn(async () => ({
    sid: "VC_TEST",
    status: "approved",
  }));
  const services = vi.fn(() => ({
    verifications: { create: createVerification },
    verificationChecks: { create: createVerificationCheck },
  }));
  class TwilioMock {
    verify = { v2: { services } };
  }

  class VoiceResponseMock {
    private clients: string[] = [];

    dial(): { client: (identity: string) => void } {
      return {
        client: (identity: string) => {
          this.clients.push(identity);
        },
      };
    }

    toString(): string {
      const clientsXml = this.clients.map((identity) => `<Client>${identity}</Client>`).join("");
      return `<Response><Dial>${clientsXml}</Dial></Response>`;
    }
  }

  const twilioMock = Object.assign(TwilioMock, {
    twiml: {
      VoiceResponse: VoiceResponseMock,
    },
  });

  return { default: twilioMock };
});

setupTestDatabase();

markReady();

process.on("unhandledRejection", (reason) => {
  throw reason;
});
