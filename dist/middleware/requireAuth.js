"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, error: "Missing token" });
    }
    const token = header.split(" ")[1];
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        return res.status(401).json({ success: false, error: "Invalid token" });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
        req.user = decoded;
        return next();
    }
    catch {
        return res.status(401).json({ success: false, error: "Invalid token" });
    }
}
exports.default = requireAuth;
