"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSMS = sendSMS;
const twilio_1 = require("./twilio");
const config_1 = require("../config");
async function sendSMS(to, body) {
    if (config_1.config.app.testMode === "true") {
        console.log("[TEST_MODE] SMS skipped");
        return { success: true };
    }
    const from = config_1.config.twilio.number || config_1.config.twilio.phone;
    if (!from || !to) {
        return;
    }
    const client = (0, twilio_1.fetchTwilioClient)();
    await client.messages.create({ to, from, body });
}
