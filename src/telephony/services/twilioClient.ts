import Twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID || "test_sid";
const authToken = process.env.TWILIO_AUTH_TOKEN || "test_token";

/*
Twilio must always be constructed with `new`.
This allows the CI test suite to inject TwilioMock
without triggering the "cannot be invoked without new" error.
*/

export const twilioClient = new Twilio(accountSid, authToken);

export const twilioVoiceGrantConfig = {
  outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
  incomingAllow: true
};

export default twilioClient;
