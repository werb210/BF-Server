"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = exports.auth = void 0;
exports.requireAuthorization = requireAuthorization;
exports.requireCapability = requireCapability;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const response_1 = require("../utils/response");
const auth = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) {
        return res.status(401).json((0, response_1.fail)("No token"));
    }
    const token = header.replace("Bearer ", "");
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        return res.status(401).json((0, response_1.fail)("Invalid token"));
    }
};
exports.auth = auth;
function getCookieToken(cookieHeader) {
    if (!cookieHeader)
        return null;
    const cookies = cookieHeader.split(";");
    for (const cookie of cookies) {
        const [rawName, ...rest] = cookie.trim().split("=");
        if (rawName !== "token")
            continue;
        const value = rest.join("=").trim();
        return value ? decodeURIComponent(value) : null;
    }
    return null;
}
const requireAuth = (req, res, next) => {
    const header = req.headers.authorization;
    let token = null;
    if (header?.startsWith("Bearer ")) {
        token = header.replace("Bearer ", "");
    }
    if (!token) {
        token = getCookieToken(req.headers.cookie);
    }
    if (!token) {
        return res.status(401).json((0, response_1.fail)("No token"));
    }
    try {
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            return res.status(401).json((0, response_1.fail)("Invalid token"));
        }
        const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
        req.user = decoded;
        return next();
    }
    catch {
        return res.status(401).json((0, response_1.fail)("Invalid token"));
    }
};
exports.requireAuth = requireAuth;
function requireAuthorization(options = {}) {
    const requiredRoles = options.roles ?? [];
    const requiredCapabilities = options.capabilities ?? [];
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json((0, response_1.fail)("No token"));
        }
        if (requiredRoles.length > 0 && (!user.role || !requiredRoles.includes(user.role))) {
            return res.status(403).json((0, response_1.fail)("Forbidden"));
        }
        if (requiredCapabilities.length > 0) {
            const userCapabilities = user.capabilities ?? [];
            const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));
            if (!allowed) {
                return res.status(403).json((0, response_1.fail)("Forbidden"));
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
