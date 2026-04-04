"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTwilioSetup = verifyTwilioSetup;
const twilioClient_1 = require("../lib/twilioClient");
async function verifyTwilioSetup() {
    if (!twilioClient_1.twilioEnabled || !twilioClient_1.twilioClient) {
        console.log("Twilio Verify skipped (not configured)");
        return;
    }
    try {
        await twilioClient_1.twilioClient.verify.v2.services(twilioClient_1.verifyServiceSid).fetch();
        console.log("Twilio Verify OK");
    }
    catch (err) {
        console.error("Twilio Verify FAILED");
        process.exit(1);
    }
}
