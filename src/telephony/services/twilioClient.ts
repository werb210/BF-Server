import Twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

export const twilioClient = Twilio(accountSid, authToken);

export const twilioVoiceGrantConfig = {
  outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
  incomingAllow: true,
};
