"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
        return res.status(401).json({ error: "unauthorized" });
    }
    const token = auth.slice("Bearer ".length).trim();
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
        req.user = {
            ...decoded,
            id: decoded.id ?? (typeof decoded.userId === "string" ? decoded.userId : undefined) ?? (typeof decoded.sub === "string" ? decoded.sub : undefined),
        };
        return next();
    }
    catch {
        return res.status(401).json({ error: "unauthorized" });
    }
}
