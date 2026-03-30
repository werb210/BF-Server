import { getTwilioClient } from "../../platform/twilioClient";
import { config } from "../../config";

export const twilioVoiceGrantConfig = {
  outgoingApplicationSid: config.twilio.voiceAppSid,
  incomingAllow: true,
};

export { getTwilioClient };
export default getTwilioClient;
