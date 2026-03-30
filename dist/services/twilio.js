"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchTwilioClient = fetchTwilioClient;
exports.fetchVerifyServiceSid = fetchVerifyServiceSid;
exports.startVerification = startVerification;
exports.checkVerification = checkVerification;
exports.isTwilioAvailable = isTwilioAvailable;
const twilio_1 = __importDefault(require("twilio"));
const config_1 = require("../config");
let client = null;
function isConfigured() {
    return !!(config_1.config.twilio.accountSid &&
        config_1.config.twilio.authToken &&
        config_1.config.twilio.verifyServiceSid);
}
function fetchClient() {
    if (!isConfigured()) {
        throw new Error("Missing required environment variable");
    }
    if (!client) {
        client = (0, twilio_1.default)(config_1.config.twilio.accountSid, config_1.config.twilio.authToken);
    }
    return client;
}
function fetchTwilioClient() {
    return fetchClient();
}
function fetchVerifyServiceSid() {
    if (!config_1.config.twilio.verifyServiceSid) {
        throw new Error("Missing required environment variable");
    }
    return config_1.config.twilio.verifyServiceSid;
}
async function startVerification(phone) {
    const twilio = fetchClient();
    return twilio.verify.v2
        .services(fetchVerifyServiceSid())
        .verifications.create({
        to: phone,
        channel: "sms",
    });
}
async function checkVerification(phone, code) {
    const twilio = fetchClient();
    return twilio.verify.v2
        .services(fetchVerifyServiceSid())
        .verificationChecks.create({
        to: phone,
        code,
    });
}
/**
 * Safe guard for tests / non-Twilio environments
 */
function isTwilioAvailable() {
    return isConfigured();
}
