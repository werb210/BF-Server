"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertTwilioConfigured = assertTwilioConfigured;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
function assertTwilioConfigured() {
    if (!process.env.TWILIO_ACCOUNT_SID
        || !process.env.TWILIO_AUTH_TOKEN) {
        throw new Error("Twilio not configured");
    }
}
function isTwilioEnabled() {
    const hasTwilioCredentials = Boolean(process.env.TWILIO_ACCOUNT_SID
        && process.env.TWILIO_AUTH_TOKEN
        && process.env.TWILIO_VOICE_APP_SID);
    return process.env.ENABLE_TWILIO === undefined
        ? hasTwilioCredentials
        : process.env.ENABLE_TWILIO === "true" && hasTwilioCredentials;
}
router.get("/token", auth_1.auth, async (req, res) => {
    const userId = req.user?.id;
    const resolvedUserId = userId
        || req.user?.userId
        || req.user?.sub;
    if (!resolvedUserId) {
        return res.status(401).json({ success: false, error: "unauthorized" });
    }
    if (!isTwilioEnabled()) {
        return res.status(503).json({ success: false, error: "Telephony disabled" });
    }
    const { generateVoiceToken } = await Promise.resolve().then(() => __importStar(require("../telephony/services/tokenService.js")));
    const token = generateVoiceToken(resolvedUserId);
    return res.status(200).json({ success: true, data: { token } });
});
exports.default = router;
