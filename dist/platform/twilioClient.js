"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTwilioClient = getTwilioClient;
const config_1 = require("../config");
let twilioClientInstance = null;
function getTwilioClient() {
    if (!twilioClientInstance) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const TwilioSDK = require("twilio");
        twilioClientInstance = new TwilioSDK(config_1.config.twilio.accountSid, config_1.config.twilio.authToken);
    }
    return twilioClientInstance;
}
exports.default = getTwilioClient;
