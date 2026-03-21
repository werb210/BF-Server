import twilio from "twilio";

let client: ReturnType<typeof twilio> | null = null;

function requireEnv(name: "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_VERIFY_SERVICE_SID"): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (process.env.TEST_MODE === "true") {
    console.warn("Twilio disabled (TEST_MODE)");
    return {
      send: async () => true,
    } as unknown as ReturnType<typeof twilio>;
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
