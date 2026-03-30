"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSms = sendSms;
const twilio_1 = require("../../services/twilio");
const config_1 = require("../../config");
async function sendSms({ to, message }) {
    if (config_1.config.app.testMode === "true") {
        console.log("[TEST_MODE] SMS skipped");
        return { success: true };
    }
    const client = (0, twilio_1.fetchTwilioClient)();
    return client.messages.create({
        body: message,
        from: config_1.config.twilio.from || config_1.config.twilio.number || config_1.config.twilio.phone,
        to,
    });
}
