import twilio from "twilio";

export function sendSMS(to: string, body: string) {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve({ sid: "test" });
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured");
  }

  if (!process.env.TWILIO_PHONE) {
    throw new Error("TWILIO_PHONE required outside test");
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );

  return client.messages.create({
    to,
    body,
    from: process.env.TWILIO_PHONE,
  });
}
