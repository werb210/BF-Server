"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTwilioWebhook = validateTwilioWebhook;
const twilioVerify_1 = require("../security/twilioVerify");
function validateTwilioWebhook(req, res, next) {
    const signature = req.headers["x-twilio-signature"];
    if (!signature || Array.isArray(signature)) {
        res.status(401).send("Missing signature");
        return;
    }
    const valid = (0, twilioVerify_1.verifyTwilioSignature)(signature, req.originalUrl, req.body);
    if (!valid) {
        res.status(403).send("Invalid Twilio signature");
        return;
    }
    next();
}
