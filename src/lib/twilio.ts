import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;
const fromNumber = process.env.TWILIO_PHONE!;

if (!accountSid || !authToken || !fromNumber) {
  console.warn("Twilio not configured");
}

const client = twilio(accountSid, authToken);

export async function sendSMS(to: string, body: string) {
  if (!accountSid || !authToken || !fromNumber) {
    console.log("Skipping SMS (Twilio not configured)", { to, body });
    return;
  }

  return client.messages.create({
    body,
    from: fromNumber,
    to,
  });
}
