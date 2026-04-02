"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.health = health;
exports.ready = ready;
const express_1 = require("express");
const ready_1 = require("../system/ready");
const router = (0, express_1.Router)();
function health(_req, res) {
    return res.status(200).json({ status: "ok" });
}
function ready(_req, res) {
    if (!(0, ready_1.isReady)()) {
        return res.status(503).json({ status: "not_ready" });
    }
    return res.json({ status: "ready" });
}
router.get("/health", health);
router.get("/healthz", health);
router.get("/ready", ready);
router.get("/readyz", ready);
exports.default = router;
