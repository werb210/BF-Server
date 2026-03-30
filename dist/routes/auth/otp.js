"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redis_js_1 = require("../../lib/redis.js");
const router = express_1.default.Router();
let twilioClient = null;
function getTwilioClient() {
    if (!twilioClient) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const twilio = require("twilio");
        twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID ?? "", process.env.TWILIO_AUTH_TOKEN ?? "");
    }
    return twilioClient;
}
const isPhone = (value) => (typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim()));
const isCode = (value) => (typeof value === "string" && /^\d{6}$/.test(value.trim()));
router.post("/start", async (req, res) => {
    const { phone } = req.body;
    if (!isPhone(phone)) {
        return res.status(400).json({ error: "invalid_payload" });
    }
    if (!process.env.TWILIO_ACCOUNT_SID
        || !process.env.TWILIO_AUTH_TOKEN
        || !process.env.TWILIO_PHONE
        || !process.env.REDIS_URL) {
        return res.status(500).json({ error: "missing_otp_env" });
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const redis = (0, redis_js_1.getRedis)();
    await redis.set(`otp:${phone}`, code, "EX", 300);
    await getTwilioClient().messages.create({
        body: `Your code is ${code}`,
        to: phone,
        from: process.env.TWILIO_PHONE,
    });
    return res.status(200).json({ success: true });
});
router.post("/verify", async (req, res) => {
    const { phone, code } = req.body;
    if (!isPhone(phone) || !isCode(code)) {
        return res.status(400).json({ error: "invalid_payload" });
    }
    if (!process.env.JWT_SECRET) {
        return res.status(500).json({ error: "missing_jwt_secret" });
    }
    const redis = (0, redis_js_1.getRedis)();
    const stored = await redis.get(`otp:${phone}`);
    if (!stored || stored !== code) {
        return res.status(400).json({ error: "Invalid code" });
    }
    const token = jsonwebtoken_1.default.sign({ phone }, process.env.JWT_SECRET, { expiresIn: "1d" });
    await redis.del(`otp:${phone}`);
    return res.status(200).json({ token });
});
exports.default = router;
