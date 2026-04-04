"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtp = sendOtp;
exports.checkOtp = checkOtp;
const twilio_1 = __importDefault(require("twilio"));
const isTest = process.env.NODE_ENV === "test";
let client = null;
if (!isTest) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        throw new Error("Twilio env missing in non-test mode");
    }
    client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}
async function sendOtp(phone) {
    if (isTest) {
        return { sid: "test" };
    }
    if (!client) {
        throw new Error("Twilio client not initialized");
    }
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifyServiceSid) {
        throw new Error("Twilio verify service is not configured");
    }
    return client.verify.v2
        .services(verifyServiceSid)
        .verifications.create({
        to: phone,
        channel: "sms",
    });
}
async function checkOtp(phone, code) {
    if (isTest) {
        return code === "123456";
    }
    if (!client) {
        throw new Error("Twilio client not initialized");
    }
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifyServiceSid) {
        throw new Error("Twilio verify service is not configured");
    }
    const result = await client.verify.v2
        .services(verifyServiceSid)
        .verificationChecks.create({
        to: phone,
        code,
    });
    return result.status === "approved";
}
