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
const response_1 = require("../lib/response");
const router = express_1.default.Router();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilioSdk = require("twilio");
const AccessToken = twilioSdk.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
router.get("/token", requireAuth_1.requireAuth, (req, res) => {
    const user = req.user;
    const identity = user?.userId ?? user?.phone ?? user?.sub ?? "unknown";
    const rid = req.rid;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_API_KEY || !process.env.TWILIO_API_SECRET) {
        if (process.env.NODE_ENV === "test") {
            return res.status(200).json({ status: "ok", data: { token: "test-voice-token" }, rid });
        }
        return res.status(500).json((0, response_1.fail)("missing_voice_env", rid));
    }
    const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { identity });
    const grant = new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID ?? process.env.TWILIO_VOICE_APP_SID,
        incomingAllow: true,
    });
    token.addGrant(grant);
    return res.status(200).json({ status: "ok", data: { token: token.toJwt() }, rid });
});
router.post("/incoming", (req, res) => {
    const voiceResponse = new VoiceResponse_1.default();
    voiceResponse.say("Connecting you to Maya.");
    voiceResponse.dial().client("maya-agent");
    return res.status(200).json({ status: "ok", data: voiceResponse.toString(), rid: req.rid });
});
router.post("/status", requireAuth_1.requireAuth, (0, validate_1.validate)(schemas_1.CallStatusSchema), (req, res) => {
    return res.status(200).json({ status: "ok", data: { received: true }, rid: req.rid });
});
exports.default = router;
