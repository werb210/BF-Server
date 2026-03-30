"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dbHealth_1 = require("../health/dbHealth");
const startupState_1 = require("../startupState");
const router = (0, express_1.Router)();
router.get("/healthz", async (_req, res) => {
    const health = await (0, dbHealth_1.dbHealth)();
    const ok = health.db === "ok";
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", ...health });
});
router.get("/readyz", (_req, res) => {
    const status = (0, startupState_1.fetchStatus)();
    const ready = status.ready && !status.reason;
    res.status(ready ? 200 : 503).json({ ready, status });
});
exports.default = router;
