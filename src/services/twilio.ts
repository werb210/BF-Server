import twilio from "twilio";

let client: ReturnType<typeof twilio> | null = null;

function requireEnv(name: "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_VERIFY_SERVICE_SID"): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function createTestTwilioClient(): ReturnType<typeof twilio> {
  return {
    verify: {
      v2: {
        services: () => ({
          verifications: {
            create: async () => ({ sid: "test_sid", status: "pending" }),
          },
          verificationChecks: {
            create: async () => ({ status: "approved" }),
          },
        }),
      },
    },
    api: {
      accounts: {
        list: async () => [],
      },
    },
    messages: {
      create: async () => ({ sid: "test_message_sid" }),
    },
  } as unknown as ReturnType<typeof twilio>;
}

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (process.env.NODE_ENV === "test" || process.env.TEST_MODE === "true") {
    return createTestTwilioClient();
  }

  if (client) return client;

  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");

  client = twilio(accountSid, authToken);
  return client;
}

export function getVerifyServiceSid(): string {
  return requireEnv("TWILIO_VERIFY_SERVICE_SID");
}
