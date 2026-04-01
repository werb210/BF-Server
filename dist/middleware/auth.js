"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = exports.authMiddleware = void 0;
exports.requireAuth = requireAuth;
exports.createAuthMiddleware = createAuthMiddleware;
exports.requireAuthorization = requireAuthorization;
exports.requireCapability = requireCapability;
const jwt_1 = require("../auth/jwt");
const errors_1 = require("../errors");
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header) {
        return res.status(401).json({ success: false, error: "UNAUTHORIZED" });
    }
    const bearerMatch = header.match(/^Bearer(?:\s+(.+))?$/i);
    if (!bearerMatch) {
        return res.status(401).json({ success: false, error: "UNAUTHORIZED" });
    }
    const token = bearerMatch[1]?.trim();
    if (!token || token === "null" || token === "undefined") {
        return res.status(401).json({ success: false, error: "INVALID_TOKEN" });
    }
    try {
        req.user = (0, jwt_1.verifyJwt)(token);
        return next();
    }
    catch {
        return res.status(401).json({ success: false, error: "INVALID_TOKEN" });
    }
}
function createAuthMiddleware() {
    return requireAuth;
}
exports.authMiddleware = requireAuth;
exports.auth = exports.authMiddleware;
function requireAuthorization(options = {}) {
    const requiredRoles = options.roles ?? [];
    const requiredCapabilities = options.capabilities ?? [];
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ success: false, error: errors_1.Errors.UNAUTHORIZED });
        }
        if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
            return res.status(403).json({ success: false, error: "FORBIDDEN" });
        }
        if (requiredCapabilities.length > 0) {
            const userCapabilities = user.capabilities ?? [];
            const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));
            if (!allowed) {
                return res.status(403).json({ success: false, error: "FORBIDDEN" });
            }
        }
        return next();
    };
}
function requireCapability(capability) {
    return requireAuthorization({
        capabilities: Array.isArray(capability) ? capability : [capability],
    });
}
