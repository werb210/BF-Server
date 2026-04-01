"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const config_1 = require("../config");
const ops_service_1 = require("../modules/ops/ops.service");
const replay_service_1 = require("../modules/ops/replay.service");
const export_service_1 = require("../modules/exports/export.service");
const auth_service_1 = require("../modules/auth/auth.service");
const roles_1 = require("../auth/roles");
const errors_1 = require("../middleware/errors");
const logger_1 = require("../observability/logger");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const apiResponse_1 = require("../lib/apiResponse");
const routeWrap_1 = require("../lib/routeWrap");
const router = (0, express_1.Router)();
let bootstrapAdminDisabled = false;
function buildRequestMetadata(req) {
    const metadata = {};
    if (req.ip) {
        metadata.ip = req.ip;
    }
    const userAgent = req.get("user-agent");
    if (userAgent) {
        metadata.userAgent = userAgent;
    }
    return metadata;
}
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
router.get("/version", (0, routeWrap_1.wrap)(async () => {
    const commitHash = config_1.config.commitSha;
    const buildTimestamp = config_1.config.buildTimestamp;
    return (0, apiResponse_1.ok)({ commitHash, buildTimestamp });
}));
router.post("/bootstrap-admin", (0, routeWrap_1.wrap)(async (req) => {
    (0, logger_1.logInfo)("bootstrap_admin_attempt", {
        disabled: bootstrapAdminDisabled,
    });
    if (bootstrapAdminDisabled) {
        throw new errors_1.AppError("bootstrap_disabled", "Bootstrap has already been used.", 410);
    }
    const phoneNumber = config_1.config.bootstrap.adminPhone;
    if (!phoneNumber) {
        throw new errors_1.AppError("bootstrap_missing_phone", "BOOTSTRAP_ADMIN_PHONE is required.", 500);
    }
    const countRes = await db_1.pool.runQuery("select count(*)::int as count from users where role = $1", [roles_1.ROLES.ADMIN]);
    const adminCount = countRes.rows[0]?.count ?? 0;
    (0, logger_1.logInfo)("bootstrap_admin_count", { adminCount });
    if (adminCount > 0) {
        (0, logger_1.logWarn)("bootstrap_admin_blocked", { reason: "admin_exists" });
        throw new errors_1.AppError("bootstrap_disabled", "Admin user already exists.", 409);
    }
    const user = await (0, auth_service_1.createUserAccount)({
        email: "todd.w@boreal.financial",
        phoneNumber,
        role: roles_1.ROLES.ADMIN,
        actorUserId: null,
        ...buildRequestMetadata(req),
    });
    bootstrapAdminDisabled = true;
    (0, logger_1.logInfo)("bootstrap_admin_success", {
        userId: user.id,
        email: user.email,
        role: user.role,
    });
    return (0, apiResponse_1.ok)({
        ok: true,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
        },
    });
}));
router.get("/ops", (0, routeWrap_1.wrap)(async () => {
    const switches = await (0, ops_service_1.listKillSwitches)();
    return (0, apiResponse_1.ok)({ switches });
}));
router.get("/jobs", (0, routeWrap_1.wrap)(async () => {
    const jobs = await (0, replay_service_1.listActiveReplayJobs)();
    return (0, apiResponse_1.ok)({ jobs });
}));
router.get("/exports/recent", (0, routeWrap_1.wrap)(async () => {
    const exports = await (0, export_service_1.listRecentExports)();
    return (0, apiResponse_1.ok)({ exports });
}));
router.get("/failed-jobs", (0, routeWrap_1.wrap)(async () => {
    const result = await db_1.pool.runQuery(`SELECT id, type, error, retry_count, created_at
       FROM failed_jobs
       ORDER BY created_at DESC
       LIMIT 100`);
    return (0, apiResponse_1.ok)(result.rows);
}));
exports.default = router;
