"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = exports.auth = void 0;
exports.requireAuth = requireAuth;
exports.requireAuthorization = requireAuthorization;
exports.requireCapability = requireCapability;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const response_1 = require("../lib/response");
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const rid = req.id ?? req.rid;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json((0, response_1.fail)("Unauthorized", rid));
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json((0, response_1.fail)("Unauthorized", rid));
    }
    const { JWT_SECRET } = (0, env_1.getEnv)();
    if (!JWT_SECRET) {
        return res.status(401).json((0, response_1.fail)("Unauthorized", rid));
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        return next();
    }
    catch {
        return res.status(401).json((0, response_1.fail)("Unauthorized", rid));
    }
}
exports.auth = requireAuth;
exports.authMiddleware = requireAuth;
function requireAuthorization(options = {}) {
    const requiredRoles = options.roles ?? [];
    const requiredCapabilities = options.capabilities ?? [];
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json((0, response_1.fail)("NO_TOKEN", req.rid));
        }
        if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
            return res.status(403).json((0, response_1.fail)("FORBIDDEN", req.rid));
        }
        if (requiredCapabilities.length > 0) {
            const userCapabilities = user.capabilities ?? [];
            const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));
            if (!allowed) {
                return res.status(403).json((0, response_1.fail)("FORBIDDEN", req.rid));
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
exports.default = requireAuth;
