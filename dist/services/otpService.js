"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeOtp = storeOtp;
exports.fetchOtp = fetchOtp;
exports.deleteOtp = deleteOtp;
const redis_1 = require("../lib/redis");
const OTP_TTL_SECONDS = 5 * 60;
const OTP_TTL_MS = OTP_TTL_SECONDS * 1000;
const MAX_OTP_ITEMS = 1000;
const store = new Map();
function otpKey(phone) {
    return `otp:${phone}`;
}
function isExpired(expires) {
    return expires <= Date.now();
}
async function storeOtp(phone, code) {
    const key = otpKey(phone);
    if (redis_1.redis) {
        await redis_1.redis.set(key, code, "EX", OTP_TTL_SECONDS);
        return;
    }
    store.set(key, {
        code,
        expires: Date.now() + OTP_TTL_MS,
    });
    setTimeout(() => store.delete(key), OTP_TTL_MS).unref();
    if (store.size > MAX_OTP_ITEMS) {
        const firstKey = store.keys().next().value;
        if (firstKey) {
            store.delete(firstKey);
        }
    }
}
async function fetchOtp(phone) {
    const key = otpKey(phone);
    if (redis_1.redis) {
        return redis_1.redis.get(key);
    }
    const entry = store.get(key);
    if (!entry) {
        return null;
    }
    if (isExpired(entry.expires)) {
        store.delete(key);
        return null;
    }
    return entry.code;
}
async function deleteOtp(phone) {
    const key = otpKey(phone);
    if (redis_1.redis) {
        await redis_1.redis.del(key);
        return;
    }
    store.delete(key);
}
