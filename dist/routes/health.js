"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const deps_1 = require("../system/deps");
const router = (0, express_1.Router)();
router.get("/health", (_req, res) => {
    res.status(200).send("ok");
});
router.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
});
router.get("/ready", (_req, res) => {
    if (!deps_1.deps.db.ready) {
        return res.status(503).json({ status: "degraded" });
    }
    return res.json({ status: "ready" });
});
router.get("/readyz", (_req, res) => {
    if (!deps_1.deps.db.ready) {
        return res.status(503).json({ status: "degraded" });
    }
    return res.json({ status: "ready" });
});
exports.default = router;
