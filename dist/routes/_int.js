"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const package_json_1 = __importDefault(require("../../package.json"));
const printRoutes_1 = require("../debug/printRoutes");
const ready_1 = require("./ready");
const auth_1 = require("../middleware/auth");
const internal_1 = __importDefault(require("./internal"));
const health_1 = require("./_int/health");
const runtime_1 = require("./_int/runtime");
const pwa_1 = __importDefault(require("./_int/pwa"));
const roles_1 = require("../auth/roles");
const router = (0, express_1.Router)();
router.get("/health", health_1.intHealthHandler);
router.get("/runtime", runtime_1.runtimeHandler);
router.get("/ready", ready_1.readyHandler);
router.get("/build", (_req, res) => {
    const buildTimestamp = config_1.config.buildTimestamp;
    res.status(200).json({ buildTimestamp });
});
router.get("/version", (_req, res) => {
    const commitHash = config_1.config.commitSha;
    const buildTimestamp = config_1.config.buildTimestamp;
    res.status(200).json({
        version: package_json_1.default.version ?? buildTimestamp ?? "unknown",
        commitHash,
    });
});
router.get("/routes", (req, res) => {
    const routes = (0, printRoutes_1.listRouteInventory)(req.app);
    res.status(200).json({ routes });
});
router.get("/env", (_req, res) => res["json"]({
    twilioAvailable: Boolean(config_1.config.twilio.accountSid &&
        config_1.config.twilio.authToken &&
        config_1.config.twilio.verifyServiceSid),
}));
router.post("/twilio-test", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), async (_req, res) => {
    return res["json"]({ ok: true });
});
router.use(pwa_1.default);
router.use(internal_1.default);
exports.default = router;
