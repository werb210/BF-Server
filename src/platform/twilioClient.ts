import twilio from "twilio";
import { config } from "../config/index.js";

let twilioClientInstance: any = null;

export function getTwilioClient() {
  if (!twilioClientInstance) {
    twilioClientInstance = twilio(config.twilio.accountSid, config.twilio.authToken);
  }

  return twilioClientInstance;
}

export default getTwilioClient;
