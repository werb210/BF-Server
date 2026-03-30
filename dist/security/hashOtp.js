"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashOtp = hashOtp;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const OTP_SECRET = config_1.config.security.otpHashSecret ?? config_1.config.jwt.secret;
function hashOtp(code) {
    return crypto_1.default.createHmac("sha256", OTP_SECRET).update(code).digest("hex");
}
