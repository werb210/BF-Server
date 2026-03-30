import { config } from "../config";

let twilioClientInstance: any = null;

export function getTwilioClient() {
  if (!twilioClientInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TwilioSDK = require("twilio");
    twilioClientInstance = new TwilioSDK(config.twilio.accountSid, config.twilio.authToken);
  }

  return twilioClientInstance;
}

export default getTwilioClient;
