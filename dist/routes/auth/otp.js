"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const twilio_1 = __importDefault(require("twilio"));
const redis_js_1 = require("../../lib/redis.js");
const router = express_1.default.Router();
const client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID ?? "", process.env.TWILIO_AUTH_TOKEN ?? "");
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
    await redis_js_1.redis.set(`otp:${phone}`, code, "EX", 300);
    await client.messages.create({
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
    const stored = await redis_js_1.redis.get(`otp:${phone}`);
    if (!stored || stored !== code) {
        return res.status(400).json({ error: "Invalid code" });
    }
    const token = jsonwebtoken_1.default.sign({ phone }, process.env.JWT_SECRET, { expiresIn: "1d" });
    await redis_js_1.redis.del(`otp:${phone}`);
    return res.status(200).json({ token });
});
exports.default = router;
