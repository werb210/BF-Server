"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AccessToken_1 = __importDefault(require("twilio/lib/jwt/AccessToken"));
const AccessToken_2 = require("twilio/lib/jwt/AccessToken");
const auth_1 = require("../middleware/auth");
const roles_1 = require("../auth/roles");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const STAFF_VOICE_ROLES = new Set([roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF, roles_1.ROLES.OPS]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidClientId(clientId) {
    return uuidPattern.test(clientId);
}
function resolveVoiceIdentity(params) {
    const { query, userId, role } = params;
    const requestedIdentity = typeof query.identity === "string" ? query.identity.trim() : "";
    const clientIdFromQuery = typeof query.clientId === "string" ? query.clientId.trim() : "";
    const isStaffRole = STAFF_VOICE_ROLES.has(role);
    if (requestedIdentity === "staff_portal" || requestedIdentity === "staff_mobile") {
        return isStaffRole ? requestedIdentity : null;
    }
    if (requestedIdentity.startsWith("client_")) {
        const clientId = requestedIdentity.slice("client_".length);
        if (!isValidClientId(clientId)) {
            return null;
        }
        if (isStaffRole || userId === clientId) {
            return requestedIdentity;
        }
        return null;
    }
    if (clientIdFromQuery.length > 0) {
        if (!isValidClientId(clientIdFromQuery)) {
            return null;
        }
        if (isStaffRole || userId === clientIdFromQuery) {
            return `client_${clientIdFromQuery}`;
        }
        return null;
    }
    if (requestedIdentity.length > 0) {
        return null;
    }
    return isStaffRole ? "staff_portal" : null;
}
router.get("/voice/token", auth_1.requireAuth, (req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ ok: false, error: "missing_token" });
        return;
    }
    const identity = resolveVoiceIdentity({
        query: req.query,
        userId: user.userId,
        role: user.role,
    });
    if (!identity) {
        res.status(400).json({ code: "invalid_identity", message: "Invalid voice identity." });
        return;
    }
    const accountSid = config_1.config.twilio.accountSid;
    const apiKey = config_1.config.twilio.apiKey;
    const apiSecret = config_1.config.twilio.apiSecret;
    const twimlAppSid = config_1.config.twilio.voiceAppSid;
    const token = new AccessToken_1.default(accountSid, apiKey, apiSecret, { identity });
    const voiceGrant = new AccessToken_2.VoiceGrant({
        outgoingApplicationSid: twimlAppSid,
        incomingAllow: true,
    });
    token.addGrant(voiceGrant);
    res["json"]({
        identity,
        token: token.toJwt(),
    });
});
exports.default = router;
