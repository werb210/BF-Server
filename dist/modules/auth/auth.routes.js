"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const otpStore_1 = require("./otpStore");
const response_1 = require("../../middleware/response");
const router = (0, express_1.Router)();
const TEST_OTP_CODE = process.env.TEST_OTP_CODE || "654321";
const error = (res, status, message) => res.status(status).json({ success: false, error: message });
function resetOtpStateForTests() {
    otpStore_1.otpStore.clear();
}
router.post("/otp/start", (req, res) => {
    const { phone } = req.body;
    if (!phone || typeof phone !== "string" || !/^\+?\d{7,15}$/.test(phone)) {
        return error(res, 400, "invalid_payload");
    }
    const existing = otpStore_1.otpStore.get(phone);
    const now = Date.now();
    if (existing && now - existing.lastSentAt < 60000) {
        return error(res, 429, "Too many requests");
    }
    const code = process.env.NODE_ENV === "test"
        ? TEST_OTP_CODE
        : Math.floor(100000 + Math.random() * 900000).toString();
    otpStore_1.otpStore.set(phone, {
        code,
        expiresAt: now + 5 * 60 * 1000,
        attempts: 0,
        lastSentAt: now,
        used: false,
    });
    return (0, response_1.ok)(res, { sent: true });
});
router.post("/otp/verify", (req, res) => {
    const { phone, code } = req.body;
    if (!phone
        || !code
        || typeof phone !== "string"
        || typeof code !== "string"
        || !/^\+?\d{7,15}$/.test(phone)
        || !/^\d{6}$/.test(code)) {
        return error(res, 400, "invalid_payload");
    }
    if (!process.env.JWT_SECRET) {
        return error(res, 401, "unauthorized");
    }
    const record = otpStore_1.otpStore.get(phone);
    if (!record) {
        return error(res, 400, "Invalid code");
    }
    const now = Date.now();
    if (now > record.expiresAt) {
        otpStore_1.otpStore.delete(phone);
        return error(res, 410, "OTP expired");
    }
    if (record.used) {
        return error(res, 400, "Invalid code");
    }
    if (record.code !== code) {
        record.attempts += 1;
        if (record.attempts >= 5) {
            otpStore_1.otpStore.delete(phone);
        }
        else {
            otpStore_1.otpStore.set(phone, record);
        }
        return error(res, 400, "Invalid code");
    }
    record.used = true;
    otpStore_1.otpStore.set(phone, record);
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        return error(res, 401, "unauthorized");
    }
    const token = jsonwebtoken_1.default.sign({ phone }, jwtSecret, { expiresIn: "1d" });
    return (0, response_1.ok)(res, { token });
});
exports.default = router;
