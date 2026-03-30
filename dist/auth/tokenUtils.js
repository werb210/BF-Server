"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = generateRefreshToken;
exports.hashRefreshToken = hashRefreshToken;
const crypto_1 = require("crypto");
function generateRefreshToken() {
    return (0, crypto_1.randomBytes)(64).toString("hex");
}
function hashRefreshToken(token) {
    return (0, crypto_1.createHash)("sha256").update(token).digest("hex");
}
