"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthHandler = healthHandler;
exports.readyHandler = readyHandler;
const express_1 = require("express");
const startupState_1 = require("../startupState");
const router = (0, express_1.Router)();
function healthHandler(_req, res) {
    res.status(200).json({ ok: true });
}
function readyHandler(_req, res) {
    if (!(0, startupState_1.isReady)()) {
        const status = (0, startupState_1.fetchStatus)();
        res.status(503).json({
            ok: false,
            code: "service_not_ready",
            reason: status.reason,
        });
        return;
    }
    res.status(200).json({ ok: true });
}
router.get("/health", healthHandler);
router.get("/ready", readyHandler);
exports.default = router;
