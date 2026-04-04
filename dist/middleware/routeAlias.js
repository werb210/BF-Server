"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeAlias = routeAlias;
const response_1 = require("../system/response");
const CANONICAL_NON_API_ROUTES = new Set([
    "/health",
    "/ready",
]);
function routeAlias(req, res, next) {
    if (!req.path.startsWith("/api/v1/") && !CANONICAL_NON_API_ROUTES.has(req.path)) {
        res.locals.__wrapped = true;
        return res.status(410).json((0, response_1.fail)("LEGACY_ROUTE_DISABLED", req.rid));
    }
    return next();
}
exports.default = routeAlias;
