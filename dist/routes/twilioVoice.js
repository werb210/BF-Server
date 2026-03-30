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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importStar(require("express"));
const twilio_1 = __importDefault(require("twilio"));
const twilioWebhookValidation_1 = require("../middleware/twilioWebhookValidation");
const router = (0, express_1.Router)();
const twilioRuntime = twilio_1.default;
router.post("/twilio/voice", express_1.default.urlencoded({ extended: false }), twilioWebhookValidation_1.twilioWebhookValidation, (_req, res) => {
    const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial({
        answerOnBridge: true,
        timeout: 20,
    });
    // Ring all staff endpoints simultaneously
    dial.client("staff_portal");
    dial.client("staff_mobile");
    res.type("text/xml");
    res.send(response.toString());
});
exports.default = router;
