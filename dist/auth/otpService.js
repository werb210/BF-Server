import { deleteOtp, fetchOtp, storeOtp as persistOtp } from "../services/otpService.js";
import { config } from "../config/index.js";
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
export async function sendOtp(phone) {
    if (config.app.testMode === "true") {
        return "000000";
    }
    const normalized = normalizePhone(phone);
    const code = generateOtp();
    await persistOtp(normalized, code);
    console.log("[OTP SEND]", normalized, code);
    return code;
}
export async function storeOtp(phone, code) {
    const normalized = normalizePhone(phone);
    await persistOtp(normalized, code);
    console.log("[OTP SEND]", normalized, code);
}
export async function verifyOtp(phone, code) {
    if (config.app.testMode === "true") {
        return code === "000000" ? { ok: true } : { ok: false, error: "invalid_code" };
    }
    const normalized = normalizePhone(phone);
    const stored = await fetchOtp(normalized);
    console.log("[OTP VERIFY]", normalized, stored, code);
    if (!stored || stored !== code) {
        return { ok: false, error: "invalid_code" };
    }
    await deleteOtp(normalized);
    return { ok: true };
}
