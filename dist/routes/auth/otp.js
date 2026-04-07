"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redis_1 = require("../../lib/redis");
const env_1 = require("../../config/env");
const response_1 = require("../../lib/response");
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
function generateOtpCode() {
    // REQUIRED FOR TEST CONTRACT:
    // OTP must be deterministic in tests to prevent flaky auth assertions.
    if (process.env.NODE_ENV === "test") {
        return process.env.TEST_OTP_CODE ?? "654321";
    }
    return String(Math.floor(100000 + Math.random() * 900000));
}
function sessionKey(phone) {
    return `otp:${phone}`;
}
async function readSession(phone) {
    const redis = (0, redis_1.getRedis)();
    const raw = await redis.get(sessionKey(phone));
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.code !== "string") {
            return null;
        }
        return {
            code: parsed.code,
            expiresAt: Number(parsed.expiresAt) || 0,
            invalidAttempts: Number(parsed.invalidAttempts) || 0,
            lastSentAt: Number(parsed.lastSentAt) || 0,
        };
    }
    catch {
        return null;
    }
}
async function writeSession(phone, session) {
    const redis = (0, redis_1.getRedis)();
    const ttlSeconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    await redis.set(sessionKey(phone), JSON.stringify(session), "EX", ttlSeconds);
}
router.post("/start", async (req, res) => {
    const { phone } = req.body;
    const rid = req.rid;
    if (!isPhone(phone)) {
        return res.status(400).json((0, response_1.fail)("invalid_payload", rid));
    }
    if (process.env.NODE_ENV !== "test"
        && (!process.env.TWILIO_ACCOUNT_SID
            || !process.env.TWILIO_AUTH_TOKEN
            || !process.env.TWILIO_PHONE)) {
        return res.status(500).json((0, response_1.fail)("missing_otp_env", rid));
    }
    let redis;
    try {
        redis = (0, redis_1.getRedis)();
    }
    catch {
        return res.status(503).json((0, response_1.fail)("service_unavailable", rid));
    }
    const existing = await readSession(phone);
    if (existing && Date.now() - existing.lastSentAt < 60000) {
        return res.status(429).json((0, response_1.fail)("Too many requests", rid));
    }
    const code = generateOtpCode();
    const expiresAt = Date.now() + (5 * 60 * 1000);
    await writeSession(phone, {
        code,
        expiresAt,
        invalidAttempts: 0,
        lastSentAt: Date.now(),
    });
    // REQUIRED FOR TEST CONTRACT:
    // External Twilio calls are skipped in tests to avoid nondeterministic/networked behavior.
    if (process.env.NODE_ENV !== "test") {
        await getTwilioClient().messages.create({
            body: `Your code is ${code}`,
            to: phone,
            from: process.env.TWILIO_PHONE,
        });
    }
    return res.status(200).json((0, response_1.ok)({ sent: true }, rid));
});
router.post("/verify", async (req, res) => {
    const { phone, code } = req.body;
    const rid = req.rid;
    if (!isPhone(phone) || !isCode(code)) {
        return res.status(400).json((0, response_1.fail)("invalid_payload", rid));
    }
    let redis;
    try {
        redis = (0, redis_1.getRedis)();
    }
    catch {
        return res.status(503).json((0, response_1.fail)("service_unavailable", rid));
    }
    const session = await readSession(phone);
    if (!session) {
        return res.status(400).json((0, response_1.fail)("Invalid code", rid));
    }
    if (Date.now() > session.expiresAt) {
        await redis.del(sessionKey(phone));
        return res.status(410).json((0, response_1.fail)("OTP expired", rid));
    }
    if (session.code !== code) {
        session.invalidAttempts += 1;
        if (session.invalidAttempts >= 5) {
            await redis.del(sessionKey(phone));
            return res.status(400).json((0, response_1.fail)("Invalid code", rid));
        }
        await writeSession(phone, session);
        return res.status(400).json((0, response_1.fail)("Invalid code", rid));
    }
    const { JWT_SECRET } = (0, env_1.getEnv)();
    if (!JWT_SECRET) {
        return res.status(401).json((0, response_1.fail)("unauthorized", rid));
    }
    const token = jsonwebtoken_1.default.sign({ phone }, JWT_SECRET, { expiresIn: "1d" });
    await redis.del(sessionKey(phone));
    return res.status(200).json((0, response_1.ok)({ token }, rid));
});
exports.default = router;
