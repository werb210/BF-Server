"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.callerId = exports.fromNumber = exports.verifyServiceSid = exports.twilioEnabled = exports.twilioClient = void 0;
exports.getTwilioClient = getTwilioClient;
const twilio_1 = __importDefault(require("twilio"));
const isTestEnv = process.env.NODE_ENV === "test";
const isConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
if (!isTestEnv && !isConfigured) {
    console.warn("Twilio not configured - disabled");
}
function createMockClient() {
    return {
        messages: {
            create: async () => ({ sid: "mock-message-sid" }),
        },
        calls: {
            create: async () => ({ sid: "mock-call-sid" }),
        },
        verify: {
            v2: {
                services: () => ({
                    fetch: async () => ({ sid: "test_verify_service_sid" }),
                    verifications: {
                        create: async () => ({ status: "pending" }),
                    },
                    verificationChecks: {
                        create: async ({ code }) => ({ status: code === "654321" ? "approved" : "pending" }),
                    },
                }),
            },
        },
    };
}
exports.twilioClient = isTestEnv
    ? createMockClient()
    : isConfigured
        ? (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
        : null;
exports.twilioEnabled = isTestEnv || isConfigured;
function getTwilioClient() {
    return exports.twilioEnabled ? exports.twilioClient : null;
}
exports.verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID || "test_verify_service_sid";
exports.fromNumber = process.env.TWILIO_FROM_NUMBER || "+15555555555";
exports.callerId = process.env.TWILIO_CALLER_ID || exports.fromNumber;
