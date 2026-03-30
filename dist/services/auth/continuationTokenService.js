"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyClientContinuationToken = verifyClientContinuationToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../../config");
function verifyClientContinuationToken(token) {
    try {
        const secret = config_1.config.jwt.secret ?? "test";
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        if (!decoded || typeof decoded.userId !== "string" || !decoded.userId.trim()) {
            return null;
        }
        return { userId: decoded.userId };
    }
    catch {
        return null;
    }
}
