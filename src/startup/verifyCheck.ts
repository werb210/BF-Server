import { twilioClient, twilioEnabled, verifyServiceSid } from "../lib/twilioClient.js";

export async function verifyTwilioSetup() {
  if (!twilioEnabled || !twilioClient) {
    console.log("Twilio Verify skipped (not configured)");
    return;
  }

  try {
    await twilioClient.verify.v2.services(verifyServiceSid).fetch();
    console.log("Twilio Verify OK");
  } catch (err) {
    console.error("Twilio Verify FAILED");
    throw err;
  }
}
