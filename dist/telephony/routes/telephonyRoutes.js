import express from "express";
import { v4 as uuid } from "uuid";
import { auth } from "../../middleware/auth.js";
import { generateVoiceToken } from "../services/tokenService.js";
const router = express.Router();
function isTwilioEnabled() {
    return Boolean(process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_VOICE_APP_SID &&
        process.env.TWILIO_API_KEY &&
        process.env.TWILIO_API_SECRET);
}
// Voice token — used by portal dialer to initialise Twilio.Device
router.get("/token", auth, async (req, res) => {
    if (!isTwilioEnabled()) {
        return res.status(503).json({ success: false, error: "Telephony not configured" });
    }
    const identity = req.user?.userId ||
        req.user?.id ||
        req.user?.sub ||
        uuid();
    try {
        const token = generateVoiceToken(identity);
        return res.status(200).json({ success: true, data: { token } });
    }
    catch (err) {
        console.error("Voice token generation failed:", err?.message);
        return res.status(500).json({ success: false, error: "token_generation_failed" });
    }
});
router.get("/presence", (_req, res) => {
    res.json({ status: "available" });
});
router.get("/call-status", (_req, res) => {
    res.json({ calls: [] });
});
router.post("/outbound-call", (_req, res) => {
    res.json({ success: true });
});
router.post("/call-status", (_req, res) => {
    res.json({ updated: true });
});
export default router;
