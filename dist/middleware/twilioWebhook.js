import { verifyTwilioSignature } from "../security/twilioVerify.js";
export function validateTwilioWebhook(req, res, next) {
    const signature = req.headers["x-twilio-signature"];
    if (!signature || Array.isArray(signature)) {
        res.status(401).send("Missing signature");
        return;
    }
    const valid = verifyTwilioSignature(signature, req.originalUrl, req.body);
    if (!valid) {
        res.status(403).send("Invalid Twilio signature");
        return;
    }
    next();
}
