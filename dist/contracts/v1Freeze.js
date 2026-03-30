"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.API_V1_FROZEN = void 0;
exports.assertApiV1Frozen = assertApiV1Frozen;
const routeRegistry_1 = require("../routes/routeRegistry");
const config_1 = require("../config");
exports.API_V1_FROZEN = true;
const FROZEN_V1_MOUNTS = [
    "/_int",
    "/internal/processing",
    "/auth",
    "/applications",
    "/calendar",
    "/calls",
    "/client",
    "/communications",
    "/banking",
    "/crm",
    "/credit",
    "/dashboard",
    "/credit-summary",
    "/documents",
    "/lender",
    "/lender-submissions",
    "/lender-products",
    "/lenders",
    "/admin",
    "/marketing",
    "/offers",
    "/messages",
    "/reporting",
    "/reports",
    "/settings",
    "/staff",
    "/tasks",
    "/users",
    "/portal",
    "/pwa",
    "/referrals",
    "/pipeline",
    "/telephony",
    "/webhooks",
    "/website",
];
function assertApiV1Frozen() {
    if (!exports.API_V1_FROZEN || config_1.config.flags.allowUnfrozenApiV1) {
        return;
    }
    const allowed = new Set(FROZEN_V1_MOUNTS);
    const violations = routeRegistry_1.API_ROUTE_MOUNTS
        .map((entry) => entry.path)
        .filter((path) => !allowed.has(path) && !path.startsWith("/v2"));
    if (violations.length > 0) {
        throw new Error(`API_V1_FROZEN violation: add new routes under /api/v2. Violations: ${violations.join(", ")}`);
    }
}
