import { config } from "../../config";
import { twilioClient } from "../../platform/twilioClient";

export const twilioVoiceGrantConfig = {
  outgoingApplicationSid: config.twilio.voiceAppSid,
  incomingAllow: true,
};

export { twilioClient };
export default twilioClient;
