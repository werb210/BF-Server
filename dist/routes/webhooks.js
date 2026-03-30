"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const webhooks_1 = require("twilio/lib/webhooks/webhooks");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const logger_1 = require("../observability/logger");
const voice_service_1 = require("../modules/voice/voice.service");
const config_1 = require("../config");
const router = (0, express_1.Router)();
function fetchTwilioAuthToken() {
    const authToken = config_1.config.twilio.authToken;
    if (!authToken || !authToken.trim()) {
        throw new errors_1.AppError("twilio_misconfigured", "Twilio auth token is missing.", 500);
    }
    return authToken.trim();
}
function buildWebhookUrl(req) {
    const baseUrl = config_1.config.app.baseUrl?.trim();
    if (baseUrl) {
        return `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice`;
    }
    const proto = req.get("x-forwarded-proto") ?? req.protocol;
    const host = req.get("x-forwarded-host") ?? req.get("host");
    if (!host) {
        throw new errors_1.AppError("invalid_request", "Missing request host.", 400);
    }
    return `${proto}://${host}${req.originalUrl}`;
}
router.post("/twilio/voice", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const signature = req.get("x-twilio-signature");
    if (!signature) {
        (0, logger_1.logWarn)("voice_webhook_missing_signature", { path: req.originalUrl });
        throw new errors_1.AppError("invalid_signature", "Missing Twilio signature.", 403);
    }
    const authToken = fetchTwilioAuthToken();
    const url = buildWebhookUrl(req);
    const valid = (0, webhooks_1.validateRequest)(authToken, signature, url, req.body ?? {});
    if (!valid) {
        (0, logger_1.logWarn)("voice_webhook_signature_invalid", { path: req.originalUrl });
        throw new errors_1.AppError("invalid_signature", "Invalid Twilio signature.", 403);
    }
    const payload = req.body ?? {};
    const callSid = typeof payload.CallSid === "string" ? payload.CallSid : null;
    if (!callSid) {
        throw new errors_1.AppError("validation_error", "Missing CallSid.", 400);
    }
    await (0, voice_service_1.handleVoiceStatusWebhook)({
        callSid,
        callStatus: typeof payload.CallStatus === "string" ? payload.CallStatus : null,
        callDuration: payload.CallDuration ?? null,
        from: typeof payload.From === "string" ? payload.From : null,
        to: typeof payload.To === "string" ? payload.To : null,
        errorCode: typeof payload.ErrorCode === "string" || typeof payload.ErrorCode === "number"
            ? String(payload.ErrorCode)
            : null,
        errorMessage: typeof payload.ErrorMessage === "string" ? payload.ErrorMessage : null,
    });
    res.status(200).json({ ok: true });
}));
exports.default = router;
