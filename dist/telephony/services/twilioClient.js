import { getTwilioClient } from "../../platform/twilioClient.js";
import { config } from "../../config/index.js";
export const twilioVoiceGrantConfig = {
    outgoingApplicationSid: config.twilio.voiceAppSid,
    incomingAllow: true,
};
export { getTwilioClient };
export default getTwilioClient;
