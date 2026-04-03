"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const VoiceResponse_1 = __importDefault(require("twilio/lib/twiml/VoiceResponse"));
const requireAuth_1 = require("../middleware/requireAuth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../schemas");
const respond_1 = require("@/lib/respond");
const router = express_1.default.Router();
router.post("/incoming", (_req, res) => {
    const voiceResponse = new VoiceResponse_1.default();
    voiceResponse.say("Connecting you to Maya.");
    voiceResponse.dial().client("maya-agent");
    return (0, respond_1.ok)(res, voiceResponse.toString());
});
router.post("/status", requireAuth_1.requireAuth, (0, validate_1.validate)(schemas_1.CallStatusSchema), (req, res) => {
    return (0, respond_1.ok)(res, { received: true });
});
exports.default = router;
