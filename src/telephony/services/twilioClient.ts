import { twilioClient } from "../../platform/twilioClient";
import { config } from "@/config";

export const twilioVoiceGrantConfig = {
  outgoingApplicationSid: config.twilio.voiceAppSid,
  incomingAllow: true,
};

export { twilioClient };
export default twilioClient;
