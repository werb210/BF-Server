"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dbHealth_1 = require("../health/dbHealth");
const startupState_1 = require("../startupState");
const response_1 = require("../middleware/response");
const withTimeout_1 = require("../utils/withTimeout");
const router = (0, express_1.Router)();
async function getDbStatus() {
    try {
        const health = await (0, withTimeout_1.withTimeout)((0, dbHealth_1.dbHealth)(), 150);
        return health.db === "ok" ? "ok" : "degraded";
    }
    catch {
        return "degraded";
    }
}
async function buildHealthPayload() {
    const dbStatus = await getDbStatus();
    return {
        server: "ok",
        twilio: process.env.TWILIO_VERIFY_SERVICE_SID ? "configured" : "missing",
        db: dbStatus,
        version: process.env.APP_VERSION ?? null,
        environment: process.env.NODE_ENV ?? "development",
    };
}
router.get("/health", async (_req, res) => {
    const payload = await buildHealthPayload();
    return (0, response_1.ok)(res, payload);
});
router.get("/healthz", async (_req, res) => {
    const payload = await buildHealthPayload();
    return (0, response_1.ok)(res, payload);
});
router.get("/readyz", (_req, res) => {
    const status = (0, startupState_1.fetchStatus)();
    const ready = status.ready && !status.reason;
    if (!ready) {
        return (0, response_1.fail)(res, 503, "not_ready");
    }
    return (0, response_1.ok)(res, { ready, status });
});
exports.default = router;
