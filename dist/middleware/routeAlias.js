"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeAlias = routeAlias;
const response_1 = require("../lib/response");
const CANONICAL_NON_API_ROUTES = new Set([
    "/",
    "/health",
    "/ready",
    "/metrics",
]);
function routeAlias(req, res, next) {
    const path = req.path;
    if (path.startsWith("/api/public")) {
        res.locals.__wrapped = true;
        return res.status(410).json((0, response_1.fail)("LEGACY_ROUTE_DISABLED", req.rid));
    }
    if (path.startsWith("/api/") || path.startsWith("/api/v1/") || CANONICAL_NON_API_ROUTES.has(path)) {
        return next();
    }
    res.locals.__wrapped = true;
    return res.status(410).json((0, response_1.fail)("LEGACY_ROUTE_DISABLED", req.rid));
}
exports.default = routeAlias;
