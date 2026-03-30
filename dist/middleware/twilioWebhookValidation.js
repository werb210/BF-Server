"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTwilioWebhook = exports.twilioWebhookValidation = void 0;
const webhooks_1 = require("twilio/lib/webhooks/webhooks");
const logger_1 = require("../observability/logger");
const config_1 = require("../config");
function resolvePublicWebhookUrl(req) {
    const forwardedProto = req.get("X-Forwarded-Proto");
    const forwardedHost = req.get("X-Forwarded-Host");
    const protocol = forwardedProto?.trim() || req.protocol;
    const host = forwardedHost?.trim() || req.get("host");
    if (!host) {
        throw new Error("Missing request host");
    }
    return `${protocol}://${host}${req.originalUrl}`;
}
const twilioWebhookValidation = (req, res, next) => {
    const authToken = config_1.config.twilio.authToken?.trim();
    if (!authToken) {
        (0, logger_1.logWarn)("twilio_webhook_auth_token_missing", { path: req.originalUrl });
        res.status(500).json({ code: "twilio_misconfigured", message: "Twilio auth token is missing." });
        return;
    }
    const signature = req.get("X-Twilio-Signature")?.trim();
    if (!signature) {
        res.status(403).json({ code: "invalid_signature", message: "Missing Twilio signature." });
        return;
    }
    const isValid = (0, webhooks_1.validateRequest)(authToken, signature, resolvePublicWebhookUrl(req), (req.body ?? {}));
    if (!isValid) {
        res.status(403).json({ code: "invalid_signature", message: "Invalid Twilio signature." });
        return;
    }
    next();
};
exports.twilioWebhookValidation = twilioWebhookValidation;
exports.validateTwilioWebhook = exports.twilioWebhookValidation;
