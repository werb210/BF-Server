"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = envCheck;
const logger_1 = require("../server/utils/logger");
const config_1 = require("../config");
function envCheck(_req, res, next) {
    if (config_1.config.env === "test") {
        next();
        return;
    }
    const required = [
        { key: "TWILIO_ACCOUNT_SID", value: config_1.config.twilio.accountSid },
        { key: "TWILIO_AUTH_TOKEN", value: config_1.config.twilio.authToken },
        { key: "TWILIO_PHONE_NUMBER", value: config_1.config.twilio.phoneNumber },
    ];
    const missing = required
        .filter(({ value }) => !value || !value.trim())
        .map(({ key }) => key);
    if (missing.length) {
        logger_1.logger.error("env_missing", { missing });
        res.status(500).json({ success: false, error: `env_missing: ${missing.join(",")}` });
        return;
    }
    next();
}
