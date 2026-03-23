import Twilio from "twilio";
import { config } from "../config";

export const twilioClient = new Twilio(config.twilio.accountSid, config.twilio.authToken);

export default twilioClient;
