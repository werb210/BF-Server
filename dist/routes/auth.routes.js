"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = require("express");
const jwt_1 = require("../auth/jwt");
const auth_1 = require("../middleware/auth");
const otp_1 = require("../services/otp");
const router = (0, express_1.Router)();
function resetOtpStateForTests() {
    globalThis.__resetOtpStateForTests?.();
}
router.get("/me", auth_1.requireAuth, (req, res) => {
    return res.status(200).json(req.user);
});
router.post("/start-otp", async (req, res) => {
    try {
        const { phone } = req.body || {};
        if (!phone || typeof phone !== "string" || phone.length < 6) {
            return res.status(400).json({ error: "INVALID_PHONE" });
        }
        await (0, otp_1.sendOtp)(phone);
        return res.status(200).json({ ok: true });
    }
    catch {
        return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
});
router.post("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.body || {};
        if (!phone || !code) {
            return res.status(400).json({ error: "INVALID_INPUT" });
        }
        const valid = await (0, otp_1.checkOtp)(phone, code);
        if (!valid) {
            return res.status(400).json({ error: "INVALID_CODE" });
        }
        const token = (0, jwt_1.signJwt)({ phone });
        return res.status(200).json({ status: "ok", data: { token } });
    }
    catch {
        return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
});
router.post("/refresh", async (req, res) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    const token = header.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    try {
        const payload = (0, jwt_1.verifyJwt)(token);
        const newToken = (0, jwt_1.signJwt)(payload);
        return res.status(200).json({ token: newToken });
    }
    catch {
        return res.status(401).json({ error: "INVALID_TOKEN" });
    }
});
exports.default = router;
