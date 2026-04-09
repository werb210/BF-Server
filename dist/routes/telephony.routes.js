import { Router } from "express";
import { auth } from "../middleware/auth.js";
const router = Router();
export function assertTwilioConfigured() {
    if (!process.env.TWILIO_ACCOUNT_SID
        || !process.env.TWILIO_AUTH_TOKEN) {
        throw new Error("Twilio not configured");
    }
}
function isTwilioEnabled() {
    const hasTwilioCredentials = Boolean(process.env.TWILIO_ACCOUNT_SID
        && process.env.TWILIO_AUTH_TOKEN
        && process.env.TWILIO_VOICE_APP_SID);
    return process.env.ENABLE_TWILIO === undefined
        ? hasTwilioCredentials
        : process.env.ENABLE_TWILIO === "true" && hasTwilioCredentials;
}
router.get("/token", auth, async (req, res) => {
    const userId = req.user?.id;
    const resolvedUserId = userId
        || req.user?.userId
        || req.user?.sub;
    if (!resolvedUserId) {
        return res.status(401).json({ success: false, error: "unauthorized" });
    }
    if (!isTwilioEnabled()) {
        return res.status(503).json({ success: false, error: "Telephony disabled" });
    }
    const { generateVoiceToken } = await import("../telephony/services/tokenService.js");
    const token = generateVoiceToken(resolvedUserId);
    return res.status(200).json({ success: true, data: { token } });
});
export default router;
