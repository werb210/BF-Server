import { config } from "../config/index.js";
import { safeImport } from "../utils/safeImport.js";

let twilioClientInstance: any = null;
const twilioFactory: any = await safeImport("twilio");

export function getTwilioClient() {
  if (!twilioFactory) {
    return null;
  }
  if (!twilioClientInstance) {
    twilioClientInstance = twilioFactory(config.twilio.accountSid, config.twilio.authToken);
  }

  return twilioClientInstance;
}

export default getTwilioClient;
