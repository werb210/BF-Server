"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const startupState_1 = require("../startupState");
const response_1 = require("../middleware/response");
const db_1 = require("../lib/db");
const router = (0, express_1.Router)();
async function healthResponse(res) {
    try {
        await (0, db_1.runQuery)("SELECT 1");
        return (0, response_1.ok)(res, { db: "ok" });
    }
    catch {
        return (0, response_1.fail)(res, 503, "DB_UNAVAILABLE");
    }
}
router.get("/health", async (_req, res) => {
    return healthResponse(res);
});
router.get("/healthz", async (_req, res) => {
    return healthResponse(res);
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
