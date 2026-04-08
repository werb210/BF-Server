"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = exports.requireAuth = void 0;
exports.auth = auth;
exports.createAuthMiddleware = createAuthMiddleware;
exports.requireAuthorization = requireAuthorization;
exports.requireCapability = requireCapability;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function auth(req, res, next) {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
        return res.status(401).json({
            status: "error",
            error: "NO_TOKEN",
        });
    }
    try {
        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET) {
            return res.status(500).json({
                status: "error",
                error: "Auth not configured",
            });
        }
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        return res.status(401).json({
            status: "error",
            error: "INVALID_TOKEN",
        });
    }
}
exports.requireAuth = auth;
function createAuthMiddleware() {
    return exports.requireAuth;
}
exports.authMiddleware = exports.requireAuth;
function requireAuthorization(options = {}) {
    const requiredRoles = options.roles ?? [];
    const requiredCapabilities = options.capabilities ?? [];
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ status: "error", error: "NO_TOKEN" });
        }
        if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
            return res.status(403).json({ status: "error", error: "FORBIDDEN" });
        }
        if (requiredCapabilities.length > 0) {
            const userCapabilities = user.capabilities ?? [];
            const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));
            if (!allowed) {
                return res.status(403).json({ status: "error", error: "FORBIDDEN" });
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
