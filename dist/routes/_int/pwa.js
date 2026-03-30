"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../../middleware/auth");
const safeHandler_1 = require("../../middleware/safeHandler");
const config_1 = require("../../config");
const pushService_1 = require("../../services/pushService");
const rateLimit_1 = require("../../middleware/rateLimit");
const pwaSyncService_1 = require("../../services/pwaSyncService");
const errors_1 = require("../../middleware/errors");
const roles_1 = require("../../auth/roles");
const router = (0, express_1.Router)();
function assertIntPwaAllowed() {
    if (config_1.config.isProduction) {
        throw new errors_1.AppError("not_found", "Not available in production.", 404);
    }
    if (config_1.config.internal.enableTestRoutes !== "true") {
        throw new errors_1.AppError("not_found", "Internal test routes disabled.", 404);
    }
}
router.post("/pwa/test-push", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, rateLimit_1.pushSendRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, _next) => {
    assertIntPwaAllowed();
    const payload = {
        type: "alert",
        title: "Test notification",
        body: "Staff PWA test push",
        level: "normal",
        sound: false,
        data: "/",
    };
    const result = await (0, pushService_1.sendNotification)({ userId: req.user.userId, role: req.user.role }, payload);
    res.status(200).json({ ok: true, result });
}));
router.post("/pwa/test-sync", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (req, res, _next) => {
    assertIntPwaAllowed();
    const requestId = res.locals.requestId ?? "unknown";
    const user = req.user;
    const replayUser = {
        userId: user.userId,
        role: user.role,
        capabilities: user.capabilities ?? [],
        ...(user.lenderId !== undefined ? { lenderId: user.lenderId } : {}),
    };
    const result = await (0, pwaSyncService_1.replaySyncBatch)({
        user: replayUser,
        payload: req.body ?? {},
        requestId,
    });
    res.status(200).json({
        ok: true,
        batchId: result.batchId,
        results: result.results,
    });
}));
exports.default = router;
