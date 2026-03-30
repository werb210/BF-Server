"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        service: "bf-server",
        timestamp: new Date().toISOString(),
    });
});
router.get("/health/db", (_req, res) => {
    res.status(200).json({
        status: "db-ok",
    });
});
router.get("/ready", (_req, res) => {
    res.status(200).json({
        ready: true,
    });
});
// Backward compatible endpoint.
router.get("/system/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: Date.now(),
    });
});
exports.default = router;
