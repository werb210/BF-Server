"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtp = sendOtp;
exports.storeOtp = storeOtp;
exports.verifyOtp = verifyOtp;
const otpService_1 = require("../services/otpService");
const config_1 = require("../config");
function normalizePhone(phone) {
    let p = phone.replace(/\D/g, "");
    if (p.length === 10)
        p = "1" + p;
    if (!p.startsWith("1"))
        throw new Error("Invalid phone");
    return `+${p}`;
}
function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
async function sendOtp(phone) {
    if (config_1.config.app.testMode === "true") {
        return "000000";
    }
    const normalized = normalizePhone(phone);
    const code = generateOtp();
    await (0, otpService_1.storeOtp)(normalized, code);
    console.log("[OTP SEND]", normalized, code);
    return code;
}
async function storeOtp(phone, code) {
    const normalized = normalizePhone(phone);
    await (0, otpService_1.storeOtp)(normalized, code);
    console.log("[OTP SEND]", normalized, code);
}
async function verifyOtp(phone, code) {
    if (config_1.config.app.testMode === "true") {
        return code === "000000" ? { ok: true } : { ok: false, error: "invalid_code" };
    }
    const normalized = normalizePhone(phone);
    const stored = await (0, otpService_1.fetchOtp)(normalized);
    console.log("[OTP VERIFY]", normalized, stored, code);
    if (!stored || stored !== code) {
        return { ok: false, error: "invalid_code" };
    }
    await (0, otpService_1.deleteOtp)(normalized);
    return { ok: true };
}
