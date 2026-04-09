import { logger } from "../server/utils/logger.js";
import { config } from "../config/index.js";
export default function envCheck(_req, res, next) {
    if (config.env === "test") {
        next();
        return;
    }
    const required = [
        { key: "TWILIO_ACCOUNT_SID", value: config.twilio.accountSid },
        { key: "TWILIO_AUTH_TOKEN", value: config.twilio.authToken },
        { key: "TWILIO_PHONE_NUMBER", value: config.twilio.phoneNumber },
    ];
    const missing = required
        .filter(({ value }) => !value || !value.trim())
        .map(({ key }) => key);
    if (missing.length) {
        logger.error("env_missing", { missing });
        res.status(500).json({ success: false, error: `env_missing: ${missing.join(",")}` });
        return;
    }
    next();
}
