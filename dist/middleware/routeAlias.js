import { fail } from "../system/response.js";
const CANONICAL_NON_API_ROUTES = new Set([
    "/health",
    "/ready",
]);
export function routeAlias(req, res, next) {
    if (!req.path.startsWith("/api/v1/") && !CANONICAL_NON_API_ROUTES.has(req.path)) {
        res.locals.__wrapped = true;
        return res.status(410).json(fail("LEGACY_ROUTE_DISABLED", req.rid));
    }
    return next();
}
export default routeAlias;
