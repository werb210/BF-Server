"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const response_1 = require("../lib/response");
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    const rid = req.id ?? req.rid;
    if (!auth || !auth.startsWith("Bearer ")) {
        return res.status(401).json((0, response_1.error)("Unauthorized", rid));
    }
    const token = auth.split(" ")[1];
    if (!token) {
        return res.status(401).json((0, response_1.error)("Unauthorized", rid));
    }
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
        return res.status(500).json((0, response_1.error)("Auth not configured", rid));
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        return next();
    }
    catch {
        return res.status(401).json((0, response_1.error)("Invalid token", rid));
    }
}
exports.default = requireAuth;
