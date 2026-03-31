import twilio from "twilio";

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
];

const isTestEnv = process.env.NODE_ENV === "test";
const missing = required.filter((key) => !process.env[key]);

if (!isTestEnv && missing.length > 0) {
  throw new Error(`Missing required env: ${missing[0]}`);
}

type VerifyResult = { status: string };

function createMockClient() {
  return {
    messages: {
      create: async () => ({ sid: "mock-message-sid" }),
    },
    calls: {
      create: async () => ({ sid: "mock-call-sid" }),
    },
    verify: {
      v2: {
        services: () => ({
          fetch: async () => ({ sid: "test_verify_service_sid" }),
          verifications: {
            create: async () => ({ status: "pending" } as VerifyResult),
          },
          verificationChecks: {
            create: async ({ code }: { code: string }) =>
              ({ status: code === "654321" ? "approved" : "pending" }) as VerifyResult,
          },
        }),
      },
    },
  };
}

export const twilioClient: any = isTestEnv
  ? createMockClient()
  : twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

export const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID || "test_verify_service_sid";
export const fromNumber = process.env.TWILIO_FROM_NUMBER || "+15555555555";
export const callerId = process.env.TWILIO_CALLER_ID || fromNumber;
