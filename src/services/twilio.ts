import twilio from "twilio";

let client: ReturnType<typeof twilio> | null = null;
let warnedMissingCredentials = false;
let warnedMissingVerifySid = false;

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (process.env.TEST_MODE === "true") {
    console.warn("Twilio disabled (TEST_MODE)");
    return {
      send: async () => true,
    } as unknown as ReturnType<typeof twilio>;
  }

  if (client) return client;

  const accountSid =
    process.env.TWILIO_ACCOUNT_SID;

  const authToken =
    process.env.TWILIO_AUTH_TOKEN ||
    process.env.TWILIO_API_SECRET;

  const apiKeySid =
    process.env.TWILIO_API_KEY_SID ||
    process.env.TWILIO_API_KEY;

  const apiSecret =
    process.env.TWILIO_API_SECRET;

  if (!accountSid || (!authToken && !(apiKeySid && apiSecret))) {
    if (!warnedMissingCredentials) {
      console.warn("Twilio credentials are missing; SMS/voice features are effectively disabled.");
      warnedMissingCredentials = true;
    }
    client = twilio(accountSid ?? "", authToken ?? "");
    return client;
  }

  client = twilio(accountSid, authToken ?? apiSecret ?? "");
  return client;
}

export function getVerifyServiceSid(): string {
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid) {
    if (!warnedMissingVerifySid) {
      console.warn("Twilio Verify service SID is missing; verification flows are effectively disabled.");
      warnedMissingVerifySid = true;
    }
    return "";
  }

  return sid;
}
