"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const auth_1 = require("../middleware/auth");
const twilioClient_1 = require("../lib/twilioClient");
const response_1 = require("../lib/response");
const router = (0, express_1.Router)();
const sendLimiter = (0, express_rate_limit_1.default)({ windowMs: 60 * 1000, max: 3 });
const verifyLimiter = (0, express_rate_limit_1.default)({ windowMs: 60 * 1000, max: 5 });
function resetOtpStateForTests() {
    // Twilio Verify owns OTP state in production; nothing to clear in process.
}
router.post("/otp/start", sendLimiter, async (req, res) => {
    const { phone } = req.body;
    if (!phone)
        return (0, response_1.fail)(res, "phone_required");
    if (!twilioClient_1.twilioEnabled || !twilioClient_1.twilioClient) {
        return (0, response_1.fail)(res, "twilio_not_configured", 503);
    }
    const client = twilioClient_1.twilioClient;
    try {
        const verification = await client.verify.v2
            .services(process.env.TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({
            to: phone,
            channel: "sms",
        });
        return (0, response_1.ok)(res, { sid: verification.sid });
    }
    catch (err) {
        console.error("❌ TWILIO ERROR:", {
            message: err.message,
            code: err.code,
            moreInfo: err.moreInfo,
        });
        return (0, response_1.fail)(res, "twilio_verify_failure");
    }
});
router.post("/otp/verify", verifyLimiter, async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) {
        return (0, response_1.fail)(res, "phone_and_code_required");
    }
    if (!twilioClient_1.twilioEnabled || !twilioClient_1.twilioClient) {
        return (0, response_1.fail)(res, "twilio_not_configured", 503);
    }
    try {
        const check = await twilioClient_1.twilioClient.verify.v2
            .services(twilioClient_1.verifyServiceSid)
            .verificationChecks.create({ to: phone, code });
        if (check.status !== "approved") {
            return (0, response_1.fail)(res, "otp_invalid", 401);
        }
        const { JWT_SECRET } = (0, env_1.getEnv)();
        const token = jsonwebtoken_1.default.sign({ phone }, JWT_SECRET, { expiresIn: "7d" });
        return (0, response_1.ok)(res, {
            verified: true,
            token,
        });
    }
    catch (err) {
        console.error("❌ TWILIO VERIFY CHECK ERROR:", {
            message: err.message,
            code: err.code,
            moreInfo: err.moreInfo,
        });
        return (0, response_1.fail)(res, "twilio_verify_failure");
    }
});
router.get("/me", auth_1.requireAuth, (req, res) => {
    return (0, response_1.ok)(res, { user: req.user ?? null });
});
router.post("/logout", (_req, res) => {
    return (0, response_1.ok)(res, { loggedOut: true });
});
exports.default = router;
